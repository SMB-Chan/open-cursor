#!/usr/bin/env python3
"""Install/restore a per-user provider-independent Cursor entry point."""
import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
HOME_DIR = Path.home()
STATE = HOME_DIR / '.local/share/cursor-open-providers'
PROFILE = HOME_DIR / '.config/Cursor-OpenProviders'
BIN = HOME_DIR / '.local/bin/cursor-open'
APPS = HOME_DIR / '.local/share/applications'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.terminal-tmp')
    with tmp.open('xb') as f:
        f.write(data)
    tmp.chmod(mode)
    tmp.replace(path)


def desktop_quote(path):
    return '"' + str(path).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$') + '"'


def payloads():
    # Separate extension root includes Continue and the workspace setup extension.
    disabled = []
    builtins = Path('/usr/share/cursor/resources/app/extensions')
    for path in sorted(builtins.glob('*/package.json')):
        p = json.loads(path.read_text())
        if p.get('name') in {
            'cursor-local-agent-runtime', 'cursor-agent-worker', 'cursor-agent-exec',
            'cursor-agent-host', 'cursor-browser-automation', 'cursor-computer-use',
            'cursor-retrieval', 'cursor-shadow-workspace', 'cursor-mcp', 'cursor-commits'
        }:
            disabled += ['--disable-extension', f"{p['publisher']}.{p['name']}"]
    args = ['/usr/bin/cursor', '--classic', '--skip-onboarding', '--skip-welcome', '--user-data-dir', str(PROFILE),
            '--extensions-dir', str(STATE / 'extensions'), '--sync', 'off',
            '--suppress-popups-on-startup', *disabled]
    launcher = '#!/bin/bash\nset -euo pipefail\nexport CONTINUE_GLOBAL_DIR=' + shlex.quote(str(STATE / 'continue')) + '\nexec ' + shlex.join(args) + ' "$@"\n'
    desktop = f'''[Desktop Entry]
Name=Cursor Open Providers
Name[ja]=Cursor（自由なLLM接続）
Comment=Cursor with Continue, your choice of LLM providers, and a local terminal
Exec={desktop_quote(BIN)} %F
Icon=co.anysphere.cursor
Type=Application
Terminal=false
StartupNotify=false
StartupWMClass=Cursor
Categories=TextEditor;Development;IDE;
Keywords=cursor;continue;llm;terminal;
Actions=new-window;

[Desktop Action new-window]
Name=New Coding Window
Name[ja]=新しいコーディングウィンドウ
Exec={desktop_quote(BIN)} --new-window
'''
    original = Path('/usr/share/applications/cursor.desktop').read_text()
    original = original.replace('Name=Cursor\n', 'Name=Cursor (Original IDE)\nName[ja]=Cursor（元のIDE）\n', 1)
    out = {
        BIN: (launcher.encode(), 0o755),
        APPS / 'cursor.desktop': (desktop.encode(), 0o644),
        APPS / 'cursor-original.desktop': (original.encode(), 0o644),
        PROFILE / 'User/settings.json': ((ROOT / 'settings.json').read_bytes(), 0o600),
        PROFILE / 'User/keybindings.json': ((ROOT / 'keybindings.json').read_bytes(), 0o600),
    }
    for name in ('package.json', 'extension.js'):
        out[STATE / 'extensions/local.open-provider-workspace-1.0.0' / name] = (
            (ROOT / 'terminal-extension' / name).read_bytes(), 0o644)
    return out


def refresh():
    if shutil.which('update-desktop-database'):
        subprocess.run(['update-desktop-database', str(APPS)], check=True)


def install_continue():
    candidates = sorted((HOME_DIR / '.cursor/extensions').glob('continue.continue-*/package.json'))
    if not candidates:
        raise SystemExit('Continue is not installed.')
    source = candidates[-1].parent
    dest = STATE / 'extensions' / source.name
    if not dest.exists():
        # Keep installed extension assets in place; no download or repackaging.
        dest.symlink_to(source, target_is_directory=True)
    config_dir = STATE / 'continue'
    config_dir.mkdir(parents=True, exist_ok=True)
    config_dir.chmod(0o700)
    if (config_dir / 'config.yaml').exists():
        print('Preserving existing provider configuration and secrets.')
        return
    old = json.loads((HOME_DIR / '.continue/config.json').read_text())
    models, templates, secrets = [], [], {}
    for index, model in enumerate(old.get('models', [])):
        migrated = {k: model[k] for k in ('provider', 'model', 'apiBase') if k in model}
        migrated.update(name=model.get('title', model['model']), roles=['chat', 'edit', 'apply'])
        key = model.get('apiKey', '')
        if key:
            match = re.fullmatch(r'\$\{([A-Z0-9_]+)\}', key)
            secret_name = match.group(1) if match else f'PROVIDER_{index}_API_KEY'
            resolved = os.environ.get(secret_name, '') if match else key
            migrated['apiKey'] = '${{ secrets.' + secret_name + ' }}'
            if not resolved:
                templates.append(migrated)
                continue
            secrets[secret_name] = resolved
        elif migrated['provider'] == 'ollama':
            # Retain the user's local model as an opt-in template until available.
            templates.append(migrated)
            continue
        if model['model'] == 'mimo-v2.5-pro':
            migrated['capabilities'] = ['tool_use']
            migrated['defaultCompletionOptions'] = {'maxTokens': 8192}
            migrated['requestOptions'] = {'extraBodyProperties': {'thinking': {'type': 'disabled'}}}
        models.append(migrated)
    if not models:
        raise SystemExit('No configured provider credentials found.')
    config = {'name': 'Open Providers', 'version': '1.0.0', 'schema': 'v1', 'models': models,
              'context': [{'provider': p} for p in ['code', 'diff', 'terminal', 'problems', 'folder']]}
    # JSON notation is valid YAML. Secret values only go into the private .env file.
    for filename, value in [('config.yaml', config), ('providers.example.yaml',
            {'name': 'Additional Providers', 'version': '1.0.0', 'schema': 'v1', 'models': templates})]:
        path = config_dir / filename
        if path.exists():
            raise SystemExit(f'Existing provider config must be preserved: {path}')
        atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2).encode(), 0o600)
    env_file = config_dir / '.env'
    if env_file.exists():
        raise SystemExit('Existing .env must be preserved.')
    atomic_write(env_file, ''.join(k + '=' + json.dumps(v) + '\n' for k, v in secrets.items()).encode(), 0o600)
    print(f'Configured {len(models)} existing provider model(s); {len(templates)} optional templates.')


def install():
    manifest_path = STATE / 'install-manifest.json'
    if manifest_path.exists():
        raise SystemExit('Already installed. Restore the previous installation first.')
    if not list((HOME_DIR / '.cursor/extensions').glob('continue.continue-*/package.json')):
        raise SystemExit('Continue is not installed.')
    if not (STATE / 'continue/config.yaml').exists():
        json.loads((HOME_DIR / '.continue/config.json').read_text())
    files = payloads()
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup = STATE / 'backups' / stamp
    backup.mkdir(parents=True)
    backup.chmod(0o700)
    manifest = {'backup': str(backup), 'files': []}
    for index, (path, (data, mode)) in enumerate(files.items()):
        if path.is_symlink():
            raise SystemExit(f'Refusing to replace symlink: {path}')
        entry = {'path': str(path), 'sha256': digest(data), 'backup': None}
        if path.exists():
            dest = backup / str(index)
            shutil.copy2(path, dest)
            entry['backup'] = str(dest)
        manifest['files'].append(entry)
    # Journal destinations before mutations, so interruption is recoverable.
    atomic_write(manifest_path, json.dumps(manifest, indent=2).encode(), 0o600)
    for path, (data, mode) in files.items():
        atomic_write(path, data, mode)
    install_continue()
    refresh()
    print(f'Installed: {BIN}\nProfile: {PROFILE}\nRestore manifest: {manifest_path}')


def restore():
    manifest_path = STATE / 'install-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    conflicts = []
    # Keep profile and extension data for recovery; only restore entry points.
    entries = [e for e in manifest['files'] if Path(e['path']) == BIN or Path(e['path']).parent == APPS]
    for entry in entries:
        path = Path(entry['path'])
        if path.is_symlink() or (path.exists() and digest(path.read_bytes()) != entry['sha256']):
            conflicts.append(str(path))
    if conflicts:
        raise SystemExit('Files changed since installation; not overwriting:\n' + '\n'.join(conflicts))
    for entry in entries:
        path = Path(entry['path'])
        if entry['backup']:
            backup = Path(entry['backup'])
            atomic_write(path, backup.read_bytes(), backup.stat().st_mode & 0o777)
        else:
            path.unlink(missing_ok=True)
    refresh()
    manifest_path.rename(manifest_path.with_name('restored-' + Path(manifest['backup']).name + '.json'))
    print('Original launchers restored. Provider profile and history preserved.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['plan', 'install', 'restore'])
    args = parser.parse_args()
    if args.action == 'plan':
        for path in payloads():
            print(path)
    elif args.action == 'install':
        install()
    else:
        restore()
