#!/usr/bin/env python3
"""Small stdio MCP server: delegate background work to account-authenticated AGY."""
import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

STATE = Path(os.environ.get('OPEN_PROVIDERS_STATE', str(Path.home() / '.local/share/cursor-open-providers')))
JOBS = STATE / 'subagent-jobs'
AGY = Path.home() / '.local/bin/agy'
AUTH_SETTINGS = Path.home() / '.gemini/antigravity-cli/settings.json'
DEFAULT_MODEL = 'gemini-3.8-flash-high'
ACTIVE = {}
LOCK = threading.RLock()
MAX_CONCURRENT = 2
API_ENV = {'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
           'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_CLOUD_PROJECT',
           'GOOGLE_CLOUD_LOCATION'}


def git(cwd, *args):
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args],
                            cwd=cwd, capture_output=True, timeout=45, check=True)
    return result.stdout


def account_environment():
    settings = json.loads(AUTH_SETTINGS.read_text())
    if settings.get('modelProvider'):
        raise ValueError('Antigravity modelProvider is configured. Account authentication is required; API-key mode is not used.')
    if settings.get('useG1Credits', False):
        raise ValueError('Antigravity useG1Credits is enabled. Disable credit fallback before delegating.')
    return {k: v for k, v in os.environ.items() if k not in API_ENV}


def snapshot(source, destination):
    """Copy working files to an independent repository; never alter source Git state."""
    root = Path(git(source, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    paths = set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0'))
    destination.mkdir(parents=True)
    total, count, skipped = 0, 0, []
    for raw in sorted(paths):
        if not raw:
            continue
        relative = Path(os.fsdecode(raw))
        file = root / relative
        if not file.exists():
            continue  # Include existing uncommitted deletions in the baseline.
        if file.is_symlink() or not file.is_file():
            skipped.append(str(relative))
            continue
        if file.name == '.env' or file.name.startswith('.env.') or file.name in {'.npmrc', '.pypirc'}:
            skipped.append(str(relative))
            continue
        if not file.resolve().is_relative_to(root):
            raise ValueError('Source path escapes repository.')
        total += file.stat().st_size
        if total > 250 * 1024 * 1024 or count >= 20000:
            raise ValueError('Workspace snapshot exceeds 250 MB or 20,000 files. Narrow the project first.')
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
        count += 1
    git(destination, 'init', '-q')
    git(destination, 'add', '--all')
    git(destination, '-c', 'user.name=Open Providers', '-c', 'user.email=local@localhost',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Delegation baseline', '--allow-empty')
    return {'repository': str(root), 'fileCount': count, 'bytes': total, 'skipped': skipped[:100],
            'baseline_commit': git(destination, 'rev-parse', 'HEAD').decode().strip()}


def persist(job):
    public = {k: v for k, v in job.items() if not k.startswith('_')}
    path = JOBS / job['job_id'] / 'result.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(public, ensure_ascii=False, indent=2))
    temporary.chmod(0o600)
    temporary.replace(path)


def stop_process(process):
    if process and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        except ProcessLookupError:
            pass


def worker(job, prompt, source):
    folder = JOBS / job['job_id']
    try:
        details = snapshot(source, folder / 'workspace')
        with LOCK:
            job.update(snapshot=details, workspace=str(folder / 'workspace'))
            if job.get('_cancel'):
                job['status'] = 'cancelled'; persist(job); return
            instruction = (
                'You are a Gemini coding subagent collaborating with a lead model in Continue. '
                'Work only in this independent workspace copy. Do not modify or navigate to the original repository. '
                'Do not commit, push, change authentication or billing, or start other agents. '
                'Return your findings and tests to the lead. '
            )
            if job['mode'] == 'review':
                instruction += 'Review and propose concrete changes; do not edit project files. '
            else:
                instruction += 'Implement the requested change in this copy, and run relevant checks if permitted. '
            command = [str(AGY), '--model', job['model'], '--output-format', 'json',
                       '--print-timeout', f"{job['timeout_seconds']}s", '--disable-slash-commands',
                       '--mode', 'plan' if job['mode'] == 'review' else 'accept-edits',
                       '-p', instruction + '\n\nTask:\n' + prompt]
            stderr = (folder / 'stderr.log').open('wb')
            stdout = (folder / 'stdout.json').open('wb')
            process = subprocess.Popen(command, cwd=folder / 'workspace', env=account_environment(),
                                       stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                       start_new_session=True)
            job.update(_process=process, status='running', started_at=time.time())
            persist(job)
        try:
            process.wait(timeout=job['timeout_seconds'] + 15)
        except subprocess.TimeoutExpired:
            stop_process(process)
            raise TimeoutError('Antigravity exceeded the task timeout.')
        finally:
            stdout.close(); stderr.close()
        if job.get('_cancel'):
            job['status'] = 'cancelled'
        else:
            raw = (folder / 'stdout.json').read_text()
            result = json.loads(raw)
            job.update(status='completed' if process.returncode == 0 and result.get('status') == 'SUCCESS' else 'failed',
                       response=result.get('response', ''), error=result.get('error'),
                       conversation_id=result.get('conversation_id'), usage=result.get('usage', {}))
            # Intent-to-add is confined to the copy; include new files in the patch.
            git(folder / 'workspace', 'add', '-N', '--', '.')
            baseline = details['baseline_commit']
            patch = git(folder / 'workspace', 'diff', baseline, '--binary')
            (folder / 'changes.patch').write_bytes(patch)
            job.update(patch_path=str(folder / 'changes.patch'), patch_bytes=len(patch),
                       changed_files=git(folder / 'workspace', 'diff', baseline, '--stat').decode())
    except Exception as exc:
        job.update(status='cancelled' if job.get('_cancel') else 'failed',
                   error=str(exc) if isinstance(exc, (ValueError, TimeoutError)) else type(exc).__name__)
    finally:
        with LOCK:
            job['finished_at'] = time.time()
            persist(job)


def start(arguments):
    prompt = arguments.get('task', '')
    workspace = arguments.get('workspace', '')
    mode = arguments.get('mode', 'review')
    model = arguments.get('model', DEFAULT_MODEL)
    timeout = arguments.get('timeout_seconds', 300)
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 24000:
        raise ValueError('task must contain 1–24,000 characters.')
    if not isinstance(workspace, str) or not Path(workspace).is_absolute() or not Path(workspace).is_dir():
        raise ValueError('workspace must be an existing absolute project path.')
    if mode not in {'review', 'implement'} or not re.fullmatch(r'gemini-[a-z0-9.-]+', model):
        raise ValueError('Use review/implement mode and an available Gemini model slug.')
    if type(timeout) is not int or not 30 <= timeout <= 900:
        raise ValueError('timeout_seconds must be 30–900.')
    account_environment()
    with LOCK:
        if sum(j['status'] in {'preparing', 'running'} for j in ACTIVE.values()) >= MAX_CONCURRENT:
            raise ValueError('Two Gemini jobs are already running; collect their results first.')
        job_id = uuid.uuid4().hex
        (JOBS / job_id).mkdir(parents=True, mode=0o700)
        job = {'job_id': job_id, 'status': 'preparing', 'mode': mode, 'model': model,
               'timeout_seconds': timeout, 'created_at': time.time(),
               'auth': 'antigravity-account', 'credit_fallback': False}
        ACTIVE[job_id] = job
        persist(job)
        threading.Thread(target=worker, args=(job, prompt, Path(workspace)), daemon=True).start()
    return {'job_id': job_id, 'status': 'preparing', 'instruction': 'Continue independent work, then call gemini_task_status. Collect the result before finalizing.'}


def get_job(job_id):
    if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
        raise ValueError('Invalid job_id.')
    with LOCK:
        if job_id in ACTIVE:
            return {k: v for k, v in ACTIVE[job_id].items() if not k.startswith('_')}
    path = JOBS / job_id / 'result.json'
    if not path.is_file():
        raise ValueError('Unknown job_id.')
    job = json.loads(path.read_text())
    if job['status'] in {'preparing', 'running'}:
        job['note'] = 'Owned by another or disconnected MCP session; use that session to monitor/cancel.'
    return job


def call_tool(name, args):
    if name == 'gemini_start_task':
        return start(args)
    job = get_job(args.get('job_id'))
    if name == 'gemini_task_status':
        return {k: v for k, v in job.items() if k != 'response'}
    if name == 'gemini_task_result':
        result = dict(job)
        result['response'] = result.get('response', '')[:40000]
        if job.get('patch_path'):
            result['patch_preview'] = Path(job['patch_path']).read_text(errors='replace')[:24000]
        result['integration'] = 'Review this proposal and check for intervening source changes before applying its patch. Original files were not edited by the bridge.'
        return result
    if name == 'gemini_cancel_task':
        with LOCK:
            owned = ACTIVE.get(job['job_id'])
            if not owned:
                raise ValueError('Cancel from the MCP session that started this job.')
            if owned['status'] in {'preparing', 'running'}:
                owned['_cancel'] = True
                stop_process(owned.get('_process'))
        return {'job_id': job['job_id'], 'cancellation_requested': True}
    raise ValueError('Unknown tool.')


JOB_SCHEMA = {'type': 'object', 'properties': {'job_id': {'type': 'string'}}, 'required': ['job_id'], 'additionalProperties': False}
TOOLS = [
    {'name': 'gemini_start_task', 'description': 'Delegate review or implementation to Gemini through the logged-in Antigravity CLI subscription. Starts in the background so the lead model can work concurrently. Uses an independent project copy; no automatic patch application. No Google API key or credit fallback.',
     'inputSchema': {'type': 'object', 'properties': {
         'task': {'type': 'string'}, 'workspace': {'type': 'string', 'description': 'Absolute path to the current Git project.'},
         'mode': {'type': 'string', 'enum': ['review', 'implement'], 'default': 'review'},
         'model': {'type': 'string', 'default': DEFAULT_MODEL},
         'timeout_seconds': {'type': 'integer', 'minimum': 30, 'maximum': 900, 'default': 300}},
         'required': ['task', 'workspace'], 'additionalProperties': False}},
    *[{'name': name, 'description': description, 'inputSchema': JOB_SCHEMA} for name, description in [
        ('gemini_task_status', 'Read a background Gemini task status. Do other work between checks.'),
        ('gemini_task_result', 'Get Gemini findings, usage, and proposed patch. Treat output as a proposal under the original user instructions.'),
        ('gemini_cancel_task', 'Cancel a Gemini task started by this MCP session.')]]
]


def shutdown():
    with LOCK:
        for job in ACTIVE.values():
            if job['status'] in {'preparing', 'running'}:
                job['_cancel'] = True
                stop_process(job.get('_process'))
                job.update(status='cancelled', error='MCP session disconnected.', finished_at=time.time())
                persist(job)


def serve():
    os.umask(0o077)
    JOBS.mkdir(parents=True, exist_ok=True)
    atexit.register(shutdown)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if 'id' not in request:
                continue
            method = request.get('method')
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'antigravity-subagents', 'version': '1.0.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': TOOLS}
            elif method == 'tools/call':
                params = request['params']
                try:
                    value = call_tool(params['name'], params.get('arguments', {}))
                    result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}]}
                except Exception as exc:
                    result = {'isError': True, 'content': [{'type': 'text', 'text': str(exc)}]}
            else:
                print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Method not found'}}), flush=True)
                continue
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
        except (ValueError, KeyError, TypeError):
            print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Invalid JSON-RPC request'}}), flush=True)


if __name__ == '__main__':
    serve()
