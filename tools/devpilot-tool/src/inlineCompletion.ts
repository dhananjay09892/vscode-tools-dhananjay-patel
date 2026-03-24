import * as vscode from 'vscode';
import * as path from 'node:path';

const DEBOUNCE_MS = 90;
const FAST_LLM_BUDGET_MS = 1200;

export interface AttachedFileContext {
  path: string;
  name: string;
  content: string;
}

export interface InlineLlmSuggestionRequest {
  document: vscode.TextDocument;
  position: vscode.Position;
  linePrefix: string;
  attachedFiles: AttachedFileContext[];
}

interface AttachmentIndex {
  exportsByName: Map<string, string>;
  functionsByName: Map<string, string[]>;
}

export function registerInlineCompletionProvider(
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem,
  output: vscode.OutputChannel,
  getAttachedFiles: () => AttachedFileContext[],
  getLlmSuggestion?: (
    request: InlineLlmSuggestionRequest,
    token: vscode.CancellationToken
  ) => Promise<string | undefined>,
  isLlmEnabled?: () => boolean
): void {
  const provider = new DevpilotInlineProvider(
    statusBar,
    output,
    getAttachedFiles,
    getLlmSuggestion,
    isLlmEnabled
  );

  const disposable = vscode.languages.registerInlineCompletionItemProvider(
    [{ scheme: 'file' }],
    provider
  );

  context.subscriptions.push(
    disposable,
    {
      dispose: () => provider.dispose()
    }
  );
}

class DevpilotInlineProvider implements vscode.InlineCompletionItemProvider {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; reject: (reason?: unknown) => void }>();
  private llmTimeoutCount = 0;
  private llmSuccessCount = 0;
  private localFallbackCount = 0;

  constructor(
    private readonly statusBar: vscode.StatusBarItem,
    private readonly output: vscode.OutputChannel,
    private readonly getAttachedFiles: () => AttachedFileContext[],
    private readonly getLlmSuggestion?: (
      request: InlineLlmSuggestionRequest,
      token: vscode.CancellationToken
    ) => Promise<string | undefined>,
    private readonly isLlmEnabled?: () => boolean
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const lineText = document.lineAt(position.line).text;
    if (position.character < lineText.length) {
      return undefined;
    }

    const key = document.uri.toString();

    try {
      await this.waitForDebounce(key, DEBOUNCE_MS, token);
    } catch {
      return undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const textBeforeCursor = lineText.slice(0, position.character);
    const attachedFiles = this.getAttachedFiles();

    if (this.getLlmSuggestion && this.isLlmEnabled?.()) {
      const llmRaw = await this.getLlmSuggestionWithinBudget(
        {
          document,
          position,
          linePrefix: textBeforeCursor,
          attachedFiles
        },
        token
      );

      const llmSuggestion = normalizeInlineContinuation(textBeforeCursor, llmRaw);
      if (llmSuggestion) {
        this.llmSuccessCount += 1;
        this.statusBar.text = '$(sparkle) Devpilot: LLM Suggesting';
        const range = new vscode.Range(position, position);
        const item = new vscode.InlineCompletionItem(llmSuggestion, range);
        this.output.appendLine(`[devpilot] inline llm suggestion for ${document.fileName}:${position.line + 1}`);
        return [item];
      }
    }

    const suggestion = buildSuggestion(document, document.languageId, textBeforeCursor, attachedFiles);
    if (!suggestion) {
      return undefined;
    }

    this.localFallbackCount += 1;
    if (
      this.localFallbackCount % 20 === 0 ||
      (this.llmTimeoutCount > 0 && this.llmTimeoutCount % 20 === 0)
    ) {
      this.output.appendLine(
        `[devpilot] inline telemetry llmSuccess=${this.llmSuccessCount} llmTimeout=${this.llmTimeoutCount} localFallback=${this.localFallbackCount}`
      );
    }

    this.statusBar.text = '$(sparkle) Devpilot: Suggesting';

    const range = new vscode.Range(position, position);
    const item = new vscode.InlineCompletionItem(suggestion, range);

    this.output.appendLine(`[devpilot] inline suggestion for ${document.fileName}:${position.line + 1}`);

    return [item];
  }

  dispose(): void {
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('disposed'));
    }

    this.pending.clear();
  }

  private waitForDebounce(key: string, ms: number, token: vscode.CancellationToken): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error('superseded'));
      this.pending.delete(key);
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve();
      }, ms);

      this.pending.set(key, { timer, reject });

      token.onCancellationRequested(() => {
        const current = this.pending.get(key);
        if (!current) {
          return;
        }

        clearTimeout(current.timer);
        this.pending.delete(key);
        reject(new Error('cancelled'));
      });
    });
  }

  private async getLlmSuggestionWithinBudget(
    request: InlineLlmSuggestionRequest,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    if (!this.getLlmSuggestion) {
      return undefined;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        this.getLlmSuggestion(request, token),
        new Promise<string | undefined>((resolve) => {
          timeoutHandle = setTimeout(() => {
            this.llmTimeoutCount += 1;
            resolve(undefined);
          }, FAST_LLM_BUDGET_MS);
        })
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

function buildSuggestion(
  document: vscode.TextDocument,
  languageId: string,
  textBeforeCursor: string,
  attachedFiles: AttachedFileContext[]
): string | undefined {
  const attachmentIndex = buildAttachmentIndex(attachedFiles);
  const trimmed = textBeforeCursor.trim();
  if (trimmed.length < 3) {
    // Allow attachment-based import hints on short lines.
    if (attachedFiles.length === 0 || attachmentIndex.exportsByName.size === 0) {
      return undefined;
    }
  }

  const firstAttachment = attachedFiles[0];

  const importSuggestion = buildImportSuggestion(document, trimmed, attachmentIndex);
  if (importSuggestion) {
    return importSuggestion;
  }

  const callSuggestion = buildFunctionCallSuggestion(trimmed, attachmentIndex);
  if (callSuggestion) {
    return callSuggestion;
  }

  if (firstAttachment && /^import\s+.+from\s+['"]$/.test(trimmed)) {
    return `${firstAttachment.name.replace(/\.[^.]+$/, '')}';`;
  }

  if (firstAttachment && trimmed.endsWith('// use attached context')) {
    return `\n// Attached reference: ${firstAttachment.name}`;
  }

  if (textBeforeCursor.endsWith('console.')) {
    return 'log()';
  }

  if (textBeforeCursor.endsWith('.map(')) {
    return '(item) => item)';
  }

  const codeLikeLanguage =
    languageId === 'typescript' ||
    languageId === 'javascript' ||
    languageId === 'typescriptreact' ||
    languageId === 'javascriptreact';

  if (codeLikeLanguage && /^(if|for|while)\s*\(.+\)$/.test(trimmed)) {
    return ' {\n\t\n}';
  }

  if (codeLikeLanguage && trimmed.endsWith('=>')) {
    return ' {\n\t\n}';
  }

  return undefined;
}

function buildAttachmentIndex(attachedFiles: AttachedFileContext[]): AttachmentIndex {
  const exportsByName = new Map<string, string>();
  const functionsByName = new Map<string, string[]>();

  for (const file of attachedFiles) {
    for (const exportedName of extractExportNames(file.content)) {
      if (!exportsByName.has(exportedName)) {
        exportsByName.set(exportedName, file.path);
      }
    }

    for (const signature of extractFunctionSignatures(file.content)) {
      if (!functionsByName.has(signature.name)) {
        functionsByName.set(signature.name, signature.params);
      }
    }
  }

  return {
    exportsByName,
    functionsByName
  };
}

function extractExportNames(content: string): string[] {
  const names = new Set<string>();
  const directExport = /export\s+(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const namedExportBlock = /export\s*\{\s*([^}]+)\s*\}/g;

  let match = directExport.exec(content);
  while (match) {
    names.add(match[1]);
    match = directExport.exec(content);
  }

  match = namedExportBlock.exec(content);
  while (match) {
    const entries = match[1].split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    for (const entry of entries) {
      const aliasParts = entry.split(/\s+as\s+/i).map((part) => part.trim());
      names.add(aliasParts[aliasParts.length - 1]);
    }
    match = namedExportBlock.exec(content);
  }

  return [...names];
}

function extractFunctionSignatures(content: string): Array<{ name: string; params: string[] }> {
  const signatures: Array<{ name: string; params: string[] }> = [];
  const regularFunction = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
  const arrowFunction = /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;

  let match = regularFunction.exec(content);
  while (match) {
    signatures.push({
      name: match[1],
      params: normalizeParams(match[2])
    });
    match = regularFunction.exec(content);
  }

  match = arrowFunction.exec(content);
  while (match) {
    signatures.push({
      name: match[1],
      params: normalizeParams(match[2])
    });
    match = arrowFunction.exec(content);
  }

  return signatures;
}

function normalizeParams(paramsRaw: string): string[] {
  return paramsRaw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const withoutDefault = part.split('=')[0].trim();
      const withoutType = withoutDefault.split(':')[0].trim();
      return withoutType.replace(/\?.*$/, '').trim();
    })
    .filter((part) => part.length > 0);
}

function buildImportSuggestion(
  document: vscode.TextDocument,
  trimmed: string,
  attachmentIndex: AttachmentIndex
): string | undefined {
  const fromEmpty = trimmed.match(/^import\s+\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s+from\s+['"]$/);
  if (fromEmpty) {
    const symbol = fromEmpty[1];
    const sourcePath = attachmentIndex.exportsByName.get(symbol);
    if (!sourcePath) {
      return undefined;
    }

    return `${toImportSpecifier(document.fileName, sourcePath)}';`;
  }

  const openBrace = trimmed.match(/^import\s+\{\s*([A-Za-z_][A-Za-z0-9_]*)$/);
  if (openBrace) {
    const symbolPrefix = openBrace[1];
    const match = [...attachmentIndex.exportsByName.keys()].find((name) => name.startsWith(symbolPrefix));
    if (!match) {
      return undefined;
    }

    const sourcePath = attachmentIndex.exportsByName.get(match);
    if (!sourcePath) {
      return undefined;
    }

    return `${match.slice(symbolPrefix.length)} } from '${toImportSpecifier(document.fileName, sourcePath)}';`;
  }

  const defaultFromEmpty = trimmed.match(/^import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+['"]$/);
  if (defaultFromEmpty) {
    const symbol = defaultFromEmpty[1];
    const sourcePath = attachmentIndex.exportsByName.get(symbol);
    if (!sourcePath) {
      return undefined;
    }

    return `${toImportSpecifier(document.fileName, sourcePath)}';`;
  }

  return undefined;
}

function buildFunctionCallSuggestion(trimmed: string, attachmentIndex: AttachmentIndex): string | undefined {
  const callMatch = trimmed.match(/([A-Za-z_][A-Za-z0-9_]*)\($/);
  if (!callMatch) {
    return undefined;
  }

  const functionName = callMatch[1];
  const params = attachmentIndex.functionsByName.get(functionName);
  if (!params || params.length === 0) {
    return undefined;
  }

  return `${params.join(', ')})`;
}

function toImportSpecifier(fromFile: string, toFile: string): string {
  const fromDir = path.dirname(fromFile);
  const relativeRaw = path.relative(fromDir, toFile).replace(/\\/g, '/');

  let withoutExt = relativeRaw.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/i, '');
  withoutExt = withoutExt.replace(/\/index$/i, '');

  if (!withoutExt.startsWith('.')) {
    return `./${withoutExt}`;
  }

  return withoutExt;
}

function normalizeInlineContinuation(prefix: string, raw?: string): string | undefined {
  const text = (raw ?? '').trim();
  if (!text) {
    return undefined;
  }

  const withoutFence = text
    .replace(/^```[a-zA-Z]*\n?/g, '')
    .replace(/\n?```$/g, '')
    .trim();

  if (!withoutFence) {
    return undefined;
  }

  const firstLine = withoutFence.split('\n')[0] ?? '';
  if (!firstLine.trim()) {
    return undefined;
  }

  if (firstLine.startsWith(prefix.trim())) {
    const remaining = firstLine.slice(prefix.trim().length).trimStart();
    return remaining.length > 0 ? remaining : undefined;
  }

  if (firstLine.length > 240) {
    return firstLine.slice(0, 240);
  }

  return firstLine;
}
