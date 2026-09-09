#!/usr/bin/env python3
"""Explicit live test: MiMo and Antigravity Gemini run concurrently on a fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

import gemini_mcp


def main():
    server = subprocess.Popen(['/usr/bin/python3', str(Path.home() / '.local/share/cursor-open-providers/gemini_mcp.py')],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    request_id = 0

    def rpc(method, params=None):
        nonlocal request_id
        request_id += 1
        server.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params or {}}) + '\n')
        server.stdin.flush()
        response = json.loads(server.stdout.readline())
        if 'error' in response:
            raise RuntimeError(response['error']['message'])
        result = response['result']
        if result.get('isError'):
            raise RuntimeError(result['content'][0]['text'])
        return result

    def tool(name, args):
        return json.loads(rpc('tools/call', {'name': name, 'arguments': args})['content'][0]['text'])

    try:
        rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                           'clientInfo': {'name': 'collaboration-check', 'version': '1'}})
        with tempfile.TemporaryDirectory(prefix='live-collaboration-') as tmp:
            repo = Path(tmp)
            gemini_mcp.git(repo, 'init', '-q')
            original = 'def add(a, b):\n    return a - b\n'
            (repo / 'add.py').write_text(original)
            job = tool('gemini_start_task', {'workspace': str(repo), 'mode': 'implement', 'timeout_seconds': 180,
                'task': 'Fix add.py so add returns the sum of a and b. Add test_add.py using unittest with positive, negative and zero cases. Run python3 -m unittest -v. Do not change any other files. Report the test result concisely.'})
            print('Gemini background job:', job['job_id'], flush=True)
            # Independent lead-model request overlaps the Gemini execution.
            config = json.loads((Path.home() / '.continue/config.json').read_text())
            model = next(m for m in config['models'] if m['model'] == 'mimo-v2.5-pro')
            endpoint = model['apiBase'].rstrip('/') + '/chat/completions'
            if endpoint != 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions':
                raise RuntimeError('Unexpected MiMo endpoint.')
            payload = {'model': model['model'], 'max_tokens': 128, 'thinking': {'type': 'disabled'},
                       'messages': [{'role': 'user', 'content': 'Review this Python function meant to add numbers: def add(a,b): return a-b. Name the fix and three useful test cases. Reply concisely.'}]}
            request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
                headers={'Authorization': 'Bearer ' + model['apiKey'], 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=40) as response:
                lead = json.load(response)
            print('MiMo independent review:', lead['choices'][0]['message']['content'], flush=True)
            deadline = time.monotonic() + 200
            while time.monotonic() < deadline:
                status = tool('gemini_task_status', {'job_id': job['job_id']})
                if status['status'] not in {'preparing', 'running'}:
                    break
                time.sleep(1)
            result = tool('gemini_task_result', {'job_id': job['job_id']})
            print('Gemini result:', json.dumps(result, ensure_ascii=False), flush=True)
            assert result['status'] == 'completed', result.get('error')
            assert (repo / 'add.py').read_text() == original
            gemini_mcp.git(repo, 'apply', '--check', result['patch_path'])
            gemini_mcp.git(repo, 'apply', result['patch_path'])
            assert 'a + b' in (repo / 'add.py').read_text() or 'a+b' in (repo / 'add.py').read_text()
            report = {'mcpHandshake': True, 'geminiJob': job['job_id'], 'model': result['model'],
                      'auth': result['auth'], 'creditFallback': False, 'mimoReview': True,
                      'sourceUnchangedUntilIntegration': True, 'patchApplicable': True,
                      'geminiResponse': result['response'], 'geminiUsage': result.get('usage')}
            Path('collaboration-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print('PASS: MiMo review and Gemini implementation; patch integrated into test fixture.', flush=True)
    finally:
        server.stdin.close()
        server.wait(timeout=15)


if __name__ == '__main__':
    main()
