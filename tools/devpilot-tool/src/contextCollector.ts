import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChatContextPayload } from './chatBackend';

const execFileAsync = promisify(execFile);

const FILE_CONTENT_CHAR_LIMIT = 12000;
const GIT_DIFF_CHAR_LIMIT = 4000;
const DIAGNOSTIC_LIMIT = 10;

export async function collectChatContext(): Promise<ChatContextPayload> {
  const editor = pickContextEditor();
  if (!editor) {
    return {
      activeFile: 'No active file',
      languageId: 'unknown',
      cursor: 'line 0, col 0',
      selectionSummary: 'Selection: (none)',
      selectionRange: 'start(0:0) end(0:0)',
      activeFileContent: '(no active file content available)',
      diagnosticsSummary: '(no diagnostics)',
      gitDiffSummary: '(git diff unavailable)'
    };
  }

  const document = editor.document;
  const selection = editor.selection;

  const selectedText = document.getText(selection).trim();
  const selectionSummary = selectedText
    ? `Selection: ${truncate(selectedText, 500)}`
    : 'Selection: (none)';

  const selectionRange = `start(${selection.start.line + 1}:${selection.start.character + 1}) end(${selection.end.line + 1}:${selection.end.character + 1})`;
  const cursor = `line ${selection.active.line + 1}, col ${selection.active.character + 1}`;

  const activeFileContent = truncate(document.getText(), FILE_CONTENT_CHAR_LIMIT);
  const diagnosticsSummary = summarizeDiagnostics(vscode.languages.getDiagnostics(document.uri));
  const gitDiffSummary = await collectGitDiffSummary(document.uri);

  return {
    activeFile: document.fileName,
    languageId: document.languageId,
    cursor,
    selectionSummary,
    selectionRange,
    activeFileContent,
    diagnosticsSummary,
    gitDiffSummary
  };
}

function pickContextEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.scheme === 'file') {
    return active;
  }

  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === 'file');
}

function summarizeDiagnostics(diagnostics: readonly vscode.Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return '(no diagnostics)';
  }

  const lines = diagnostics.slice(0, DIAGNOSTIC_LIMIT).map((d) => {
    const severity = diagnosticSeverityToString(d.severity);
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    return `${severity} at ${line}:${col} - ${d.message}`;
  });

  if (diagnostics.length > DIAGNOSTIC_LIMIT) {
    lines.push(`...and ${diagnostics.length - DIAGNOSTIC_LIMIT} more diagnostics`);
  }

  return lines.join('\n');
}

function diagnosticSeverityToString(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'Error';
    case vscode.DiagnosticSeverity.Warning:
      return 'Warning';
    case vscode.DiagnosticSeverity.Information:
      return 'Info';
    case vscode.DiagnosticSeverity.Hint:
      return 'Hint';
    default:
      return 'Unknown';
  }
}

async function collectGitDiffSummary(uri: vscode.Uri): Promise<string> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return '(git diff unavailable)';
  }

  const relativePath = vscode.workspace.asRelativePath(uri, false);

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--', relativePath],
      {
        cwd: workspaceFolder.uri.fsPath,
        timeout: 1500,
        maxBuffer: 1024 * 1024
      }
    );

    const trimmed = stdout.trim();
    if (!trimmed) {
      return '(no git diff for active file)';
    }

    return truncate(trimmed, GIT_DIFF_CHAR_LIMIT);
  } catch {
    return '(git diff unavailable)';
  }
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n...<truncated ${value.length - limit} chars>`;
}
