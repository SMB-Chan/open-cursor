import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import gemini_mcp as server


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='gemini-bridge-test-')
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        server.git(self.repo, 'init', '-q')
        (self.repo / 'add.py').write_text('def add(a, b): return a - b\n')
        (self.repo / '.gitignore').write_text('.env\n')
        server.git(self.repo, 'add', '.')
        server.git(self.repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost',
                   '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
        (self.repo / 'add.py').write_text('def add(a, b):\n    return a - b\n')
        (self.repo / 'untracked.txt').write_text('keep this context\n')
        (self.repo / '.env').write_text('SECRET=test-value\n')
        settings = self.root / 'settings.json'
        settings.write_text('{"useG1Credits": false}')
        fake = self.root / 'agy'
        fake.write_text('''#!/usr/bin/python3
import json,time
from pathlib import Path
time.sleep(0.3)
Path('add.py').write_text('def add(a, b):\\n    return a + b\\n')
print(json.dumps({'status':'SUCCESS','response':'Fixed addition','conversation_id':'test','usage':{}}))
''')
        fake.chmod(0o755)
        self.patches = [patch.object(server, 'JOBS', self.root / 'jobs'),
                        patch.object(server, 'AGY', fake), patch.object(server, 'AUTH_SETTINGS', settings),
                        patch.object(server, 'ACTIVE', {})]
        for p in self.patches: p.start()

    def tearDown(self):
        server.shutdown()
        for p in reversed(self.patches): p.stop()
        self.tmp.cleanup()

    def wait(self, job_id):
        deadline = time.time() + 10
        while time.time() < deadline:
            job = server.get_job(job_id)
            if job['status'] not in {'preparing', 'running'}: return job
            time.sleep(0.05)
        self.fail('job timed out')

    def test_snapshot_patch_and_concurrency(self):
        args = {'task': 'Fix addition', 'workspace': str(self.repo), 'mode': 'implement'}
        first = server.start(args)
        second = server.start(args)
        with self.assertRaisesRegex(ValueError, 'already running'): server.start(args)
        for job_id in [first['job_id'], second['job_id']]:
            job = self.wait(job_id)
            self.assertEqual(job['status'], 'completed', job)
            workspace = Path(job['workspace'])
            self.assertFalse((workspace / '.env').exists())
            self.assertEqual((workspace / 'untracked.txt').read_text(), 'keep this context\n')
            diff = Path(job['patch_path']).read_text()
            self.assertIn('+    return a + b', diff)
            server.git(self.repo, 'apply', '--check', job['patch_path'])
        self.assertEqual((self.repo / 'add.py').read_text(), 'def add(a, b):\n    return a - b\n')

    def test_account_mode_guard(self):
        with patch.dict(os.environ, {'GEMINI_API_KEY': 'do-not-inherit', 'GOOGLE_GEMINI_BASE_URL': 'invalid'}):
            env = server.account_environment()
            self.assertNotIn('GEMINI_API_KEY', env)
            self.assertNotIn('GOOGLE_GEMINI_BASE_URL', env)
        server.AUTH_SETTINGS.write_text('{"modelProvider":"gemini"}')
        with self.assertRaises(ValueError): server.account_environment()
        server.AUTH_SETTINGS.write_text('{"useG1Credits":true}')
        with self.assertRaises(ValueError): server.account_environment()

    def test_rpc_handshake(self):
        request = '\n'.join(json.dumps(r) for r in [
            {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05'}},
            {'jsonrpc':'2.0','method':'notifications/initialized'},
            {'jsonrpc':'2.0','id':2,'method':'tools/list'}]) + '\n'
        env = dict(os.environ, OPEN_PROVIDERS_STATE=str(self.root / 'rpc-state'))
        p = subprocess.run(['/usr/bin/python3', str(Path(server.__file__))], input=request,
                           capture_output=True, text=True, env=env, timeout=5, check=True)
        responses = [json.loads(line) for line in p.stdout.splitlines()]
        self.assertEqual(len(responses), 2)
        self.assertEqual(len(responses[1]['result']['tools']), 4)


if __name__ == '__main__': unittest.main()
