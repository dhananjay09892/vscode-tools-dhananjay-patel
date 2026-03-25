import * as vscode from 'vscode';

const QUICK_FIX_KIND = vscode.CodeActionKind.QuickFix;

const KEYWORD_MERGE_REGEX = /\b(import|from|class|def|function|const|let|var|return|export|interface|type|package)(?=[A-Za-z_])/g;

export interface DiagnosticLineFix {
  title: string;
  nextLineText: string;
}

export function registerDiagnosticQuickFixProvider(
  context: vscode.ExtensionContext
): void {
  const provider = new DevpilotDiagnosticQuickFixProvider();

  const disposable = vscode.languages.registerCodeActionsProvider(
    [{ scheme: 'file' }],
    provider,
    { providedCodeActionKinds: [QUICK_FIX_KIND] }
  );

  context.subscriptions.push(disposable);
}

class DevpilotDiagnosticQuickFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    if (token.isCancellationRequested || context.diagnostics.length === 0) {
      return [];
    }

    const line = range.start.line;
    return computeDiagnosticLineFixes(document, line).map((fix) => {
      return this.createReplaceLineAction(document, line, fix.nextLineText, fix.title);
    });
  }

  private createReplaceLineAction(
    document: vscode.TextDocument,
    line: number,
    nextLineText: string,
    title: string
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(title, QUICK_FIX_KIND);
    const edit = new vscode.WorkspaceEdit();
    const lineRange = document.lineAt(line).range;
    edit.replace(document.uri, lineRange, nextLineText);
    action.edit = edit;
    action.isPreferred = true;
    return action;
  }
}

export function computeDiagnosticLineFixes(document: vscode.TextDocument, line: number): DiagnosticLineFix[] {
  const lineText = document.lineAt(line).text;
  const fixes: DiagnosticLineFix[] = [];

  const normalized = normalizeKeywordMerges(lineText);
  if (normalized && normalized !== lineText) {
    fixes.push({
      title: 'Devpilot: Fix merged keywords on this line',
      nextLineText: normalized
    });
  }

  const reindented = buildIndentNormalizedLine(document, line);
  if (reindented && reindented !== lineText) {
    fixes.push({
      title: 'Devpilot: Re-indent this line using editor tab settings',
      nextLineText: reindented
    });
  }

  return fixes;
}

function normalizeKeywordMerges(lineText: string): string | undefined {
  KEYWORD_MERGE_REGEX.lastIndex = 0;
  if (!KEYWORD_MERGE_REGEX.test(lineText)) {
    return undefined;
  }

  KEYWORD_MERGE_REGEX.lastIndex = 0;

  return lineText.replace(KEYWORD_MERGE_REGEX, '$1 ');
}

function buildIndentNormalizedLine(document: vscode.TextDocument, line: number): string | undefined {
  const current = document.lineAt(line).text;
  const trimmed = current.trimStart();
  if (!trimmed) {
    return undefined;
  }

  const previous = findPreviousNonEmptyLine(document, line);
  if (!previous) {
    return undefined;
  }

  const indentUnit = resolveIndentUnit(document);
  const previousIndent = getLeadingWhitespace(previous.text);
  let targetIndent = previousIndent;

  const prevTrimmed = previous.text.trimEnd();
  if (/[{[(:]$/.test(prevTrimmed)) {
    targetIndent = previousIndent + indentUnit;
  }

  if (/^[}\])]/.test(trimmed)) {
    targetIndent = decreaseIndent(targetIndent, indentUnit);
  }

  return `${targetIndent}${trimmed}`;
}

function findPreviousNonEmptyLine(document: vscode.TextDocument, fromLine: number): vscode.TextLine | undefined {
  for (let line = fromLine - 1; line >= 0; line -= 1) {
    const candidate = document.lineAt(line);
    if (candidate.text.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function resolveIndentUnit(document: vscode.TextDocument): string {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.toString() === document.uri.toString()) {
    const insertSpaces = active.options.insertSpaces;
    const tabSizeRaw = active.options.tabSize;
    const tabSize = typeof tabSizeRaw === 'number' && Number.isFinite(tabSizeRaw) ? Math.max(1, Math.trunc(tabSizeRaw)) : 2;
    if (insertSpaces === false) {
      return '\t';
    }

    return ' '.repeat(tabSize);
  }

  const editorCfg = vscode.workspace.getConfiguration('editor', document.uri);
  const insertSpaces = editorCfg.get<boolean>('insertSpaces', true);
  const tabSize = Math.max(1, Math.trunc(editorCfg.get<number>('tabSize', 2)));
  return insertSpaces ? ' '.repeat(tabSize) : '\t';
}

function getLeadingWhitespace(lineText: string): string {
  const match = lineText.match(/^\s*/);
  return match ? match[0] : '';
}

function decreaseIndent(value: string, indentUnit: string): string {
  if (!value) {
    return value;
  }

  if (indentUnit === '\t') {
    return value.endsWith('\t') ? value.slice(0, -1) : value;
  }

  return value.length >= indentUnit.length ? value.slice(0, value.length - indentUnit.length) : '';
}