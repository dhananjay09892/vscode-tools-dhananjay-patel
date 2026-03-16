import * as vscode from 'vscode';
import { ValidatorConfig } from './types';
import { runValidation } from './validator';

const OUTPUT_CHANNEL_NAME = 'Architecture Validator';
const CONFIG_FILE = 'architecture-validator.config.json';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  const disposable = vscode.commands.registerCommand('architectureValidator.validate', async () => {
    channel.clear();
    channel.appendLine('Running architecture validation...');

    const config = await readConfig();
    if (!config) {
      vscode.window.showErrorMessage('Architecture Validator: config file not found.');
      channel.appendLine(`Missing ${CONFIG_FILE} in workspace root.`);
      channel.show(true);
      return;
    }

    const violations = await runValidation(config);
    if (violations.length === 0) {
      const ok = 'Architecture Validator: no layer violations found.';
      vscode.window.showInformationMessage(ok);
      channel.appendLine(ok);
      channel.show(true);
      return;
    }

    channel.appendLine(`Found ${violations.length} violation(s):`);
    for (const v of violations) {
      channel.appendLine(`- ${v.message}`);
      channel.appendLine(`  file: ${v.file}:${v.line}`);
      channel.appendLine(`  import: ${v.importText}`);
    }

    vscode.window.showWarningMessage(`Architecture Validator: ${violations.length} violation(s) found.`);
    channel.show(true);
  });

  context.subscriptions.push(disposable, channel);
}

async function readConfig(): Promise<ValidatorConfig | undefined> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return undefined;
  }

  const root = vscode.workspace.workspaceFolders[0].uri;
  const configUri = vscode.Uri.joinPath(root, CONFIG_FILE);

  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    const text = Buffer.from(bytes).toString('utf-8');
    return JSON.parse(text) as ValidatorConfig;
  } catch {
    return undefined;
  }
}

export function deactivate(): void {
  // No-op.
}
