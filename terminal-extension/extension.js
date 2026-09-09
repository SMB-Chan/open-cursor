'use strict';
const vscode = require('vscode');

async function activate(context) {
  const log = vscode.window.createOutputChannel('Local Terminal');
  context.subscriptions.push(log);
  const available = new Set(await vscode.commands.getCommands(true));
  async function run(command) {
    if (!available.has(command)) {
      log.appendLine(`Command unavailable: ${command}`);
      return;
    }
    await vscode.commands.executeCommand(command);
  }
  async function focus(create = false) {
    await run('aichat.close-sidebar');
    const terminal = !create && (vscode.window.activeTerminal || vscode.window.terminals[0]) ||
      vscode.window.createTerminal({
        name: 'Local Shell',
        location: vscode.TerminalLocation.Panel
      });
    terminal.show(false);
    const pid = await terminal.processId;
    log.appendLine(`Local shell ready; pid=${pid}`);
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(context.globalStorageUri, 'status.json'),
      Buffer.from(JSON.stringify({ version: 1, terminalPid: pid, time: new Date().toISOString() }, null, 2))
    );
    return terminal;
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('localTerminal.focus', () => focus()),
    vscode.commands.registerCommand('localTerminal.new', () => focus(true)),
    vscode.commands.registerCommand('openProviders.configure', () =>
      vscode.commands.executeCommand('continue.openConfigPage'))
  );
  // Cursor registers this setting as an explicit language list, not a wildcard.
  const languages = await vscode.languages.getLanguages();
  const config = vscode.workspace.getConfiguration();
  const disabled = config.get('cursor.cpp.disabledLanguages', []);
  const all = [...new Set([...disabled, ...languages])].sort();
  if (JSON.stringify(disabled) !== JSON.stringify(all)) {
    await config.update('cursor.cpp.disabledLanguages', all, vscode.ConfigurationTarget.Global);
  }
  await focus();
  await vscode.commands.executeCommand('workbench.view.extension.continue');
  const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  button.text = '$(settings-gear) LLM Providers';
  button.tooltip = 'Continue: 接続先プロバイダとモデルの設定';
  button.command = 'openProviders.configure';
  button.show();
  context.subscriptions.push(button);
}

module.exports = { activate };
