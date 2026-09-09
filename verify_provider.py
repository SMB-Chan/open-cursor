#!/usr/bin/env python3
"""Bounded synthetic test using only the already-configured MiMo endpoint."""
import json
from pathlib import Path
import urllib.request
import urllib.error
import sys


def main():
    old = json.loads((Path.home() / '.continue/config.json').read_text())
    model = next(m for m in old['models'] if m['model'] == 'mimo-v2.5-pro')
    endpoint = model['apiBase'].rstrip('/') + '/chat/completions'
    if endpoint != 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions':
        raise SystemExit('Endpoint changed; review before sending credentials.')
    messages = [{'role': 'user', 'content': 'Call add with a=17 and b=25, then report the result. This is a synthetic connection test.'}]
    tools = [{'type': 'function', 'function': {'name': 'add', 'description': 'Add two numbers.',
        'parameters': {'type': 'object', 'properties': {'a': {'type': 'integer'}, 'b': {'type': 'integer'}},
                       'required': ['a', 'b'], 'additionalProperties': False}}}]
    usage = 0
    for turn in range(2):
        payload = {'model': model['model'], 'messages': messages, 'tools': tools,
                   'max_tokens': 256, 'stream': False, 'thinking': {'type': 'disabled'}}
        request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + model['apiKey'], 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            # Do not print headers or remote text which may contain credentials.
            print(json.dumps({'ok': False, 'httpStatus': exc.code})); return 1
        except Exception as exc:
            print(json.dumps({'ok': False, 'errorType': type(exc).__name__})); return 1
        usage += result.get('usage', {}).get('total_tokens', 0)
        message = result['choices'][0]['message']
        if turn == 0:
            calls = message.get('tool_calls', [])
            if len(calls) != 1 or calls[0]['function']['name'] != 'add':
                print(json.dumps({'ok': False, 'stage': 'tool_call', 'tokens': usage})); return 1
            args = json.loads(calls[0]['function']['arguments'])
            if args != {'a': 17, 'b': 25}:
                print(json.dumps({'ok': False, 'stage': 'tool_arguments', 'tokens': usage})); return 1
            messages.extend([message, {'role': 'tool', 'tool_call_id': calls[0]['id'], 'content': '42'}])
        else:
            ok = '42' in (message.get('content') or '')
            print(json.dumps({'ok': ok, 'model': model['model'], 'toolRoundTrip': ok, 'tokens': usage}))
            return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
