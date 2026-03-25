import * as vscode from 'vscode';
import * as path from 'node:path';
import { computeDiagnosticLineFixes } from './diagnosticFixes';

const FORCE_DIAGNOSTIC_GHOST_URIS = new Set<string>();

const DEFAULT_DEBOUNCE_MS = 90;
const DEFAULT_FAST_LLM_BUDGET_MS = 1200;
const DEFAULT_INLINE_CACHE_TTL_MS = 15000;
const DEFAULT_INLINE_CACHE_MAX_ENTRIES = 200;

export interface InlinePerformanceConfig {
  debounceMs: number;
  llmBudgetMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
}

export type InlineDiagnosticFixMode = 'errorOnly' | 'errorAndWarning' | 'always';

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

export function forceNextDiagnosticGhostForDocument(documentUri: vscode.Uri): void {
  FORCE_DIAGNOSTIC_GHOST_URIS.add(documentUri.toString());
}

interface AttachmentIndex {
  exportsByName: Map<string, string>;
  functionsByName: Map<string, string[]>;
}

interface RankedInlineCandidate {
  source: 'llm' | 'local' | 'fix';
  item: vscode.InlineCompletionItem;
  text: string;
  score: number;
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
  isLlmEnabled?: () => boolean,
  getInlinePerfConfig?: () => InlinePerformanceConfig,
  getInlineDiagnosticFixMode?: () => InlineDiagnosticFixMode
): void {
  const provider = new DevpilotInlineProvider(
    statusBar,
    output,
    getAttachedFiles,
    getLlmSuggestion,
    isLlmEnabled,
    getInlinePerfConfig,
    getInlineDiagnosticFixMode
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
  private readonly llmCache = new Map<string, { value: string; expiresAt: number }>();
  private readonly inFlightLlm = new Map<string, Promise<string | undefined>>();
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
    private readonly isLlmEnabled?: () => boolean,
    private readonly getInlinePerfConfig?: () => InlinePerformanceConfig,
    private readonly getInlineDiagnosticFixMode?: () => InlineDiagnosticFixMode
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

    const forceDiagnosticGhost = FORCE_DIAGNOSTIC_GHOST_URIS.delete(document.uri.toString());
    const diagnosticItem = this.buildDiagnosticInlineItem(document, position);
    if (forceDiagnosticGhost && diagnosticItem) {
      this.statusBar.text = '$(sparkle) Devpilot: Fix Suggestion';
      this.statusBar.tooltip = 'Devpilot fix suggestion is available on this line. Press Tab to accept or Esc to dismiss.';
      return [diagnosticItem];
    }

    const lineText = document.lineAt(position.line).text;
    if (position.character < lineText.length) {
      return undefined;
    }

    const key = document.uri.toString();
    const perfConfig = this.resolveInlinePerfConfig();

    try {
      await this.waitForDebounce(key, perfConfig.debounceMs, token);
    } catch {
      return undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const textBeforeCursor = lineText.slice(0, position.character);
    const attachedFiles = this.getAttachedFiles();
    const requestKey = this.createInlineRequestKey(document, position, textBeforeCursor, attachedFiles);
    const candidates: RankedInlineCandidate[] = [];

    if (this.getLlmSuggestion && this.isLlmEnabled?.()) {
      const llmRaw = await this.getLlmSuggestionWithCache(
        requestKey,
        {
          document,
          position,
          linePrefix: textBeforeCursor,
          attachedFiles
        },
        perfConfig,
        token
      );

      const llmSuggestion = normalizeInlineContinuation(textBeforeCursor, llmRaw);
      const vettedSuggestion = vetInlineSuggestion(textBeforeCursor, llmSuggestion, document.languageId);
      if (vettedSuggestion && !shouldBlockSuggestionAtCursor(document, position, vettedSuggestion, document.languageId)) {
        const range = new vscode.Range(position, position);
        const item = new vscode.InlineCompletionItem(vettedSuggestion, range);
        candidates.push({
          source: 'llm',
          item,
          text: vettedSuggestion,
          score: scoreInlineCandidate('llm', vettedSuggestion, document, position)
        });
      }
    }

    const suggestion = buildSuggestion(document, document.languageId, textBeforeCursor, attachedFiles);
    if (suggestion) {
      const range = new vscode.Range(position, position);
      const item = new vscode.InlineCompletionItem(suggestion, range);
      candidates.push({
        source: 'local',
        item,
        text: suggestion,
        score: scoreInlineCandidate('local', suggestion, document, position)
      });
    }

    if (diagnosticItem && typeof diagnosticItem.insertText === 'string') {
      const fixText = diagnosticItem.insertText;
      candidates.push({
        source: 'fix',
        item: diagnosticItem,
        text: fixText,
        score: scoreInlineCandidate('fix', fixText, document, position)
      });
    }

    if (candidates.length === 0) {
      return undefined;
    }

    const ranked = candidates
      .sort((a, b) => b.score - a.score)
      .filter((candidate, index, all) => all.findIndex((entry) => entry.text === candidate.text) === index);

    const top = ranked[0];
    if (top.source === 'llm') {
      this.llmSuccessCount += 1;
      this.statusBar.text = '$(sparkle) Devpilot: LLM Suggesting';
      this.output.appendLine(`[devpilot] inline llm suggestion for ${document.fileName}:${position.line + 1}`);
    } else if (top.source === 'local') {
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
      this.output.appendLine(`[devpilot] inline suggestion for ${document.fileName}:${position.line + 1}`);
    } else {
      this.statusBar.text = '$(sparkle) Devpilot: Fix Suggestion';
      this.statusBar.tooltip = 'Devpilot fix suggestion is available on this line. Press Tab to accept or Esc to dismiss.';
    }

    return ranked.slice(0, 2).map((candidate) => candidate.item);
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
    budgetMs: number,
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
          }, budgetMs);
        })
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async getLlmSuggestionWithCache(
    cacheKey: string,
    request: InlineLlmSuggestionRequest,
    perfConfig: InlinePerformanceConfig,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.llmCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    if (cached) {
      this.llmCache.delete(cacheKey);
    }

    const existing = this.inFlightLlm.get(cacheKey);
    if (existing) {
      return await existing;
    }

    const task = this.getLlmSuggestionWithinBudget(request, perfConfig.llmBudgetMs, token)
      .then((value) => {
        const normalized = normalizeInlineContinuation(request.linePrefix, value);
        if (normalized) {
          this.setLlmCache(cacheKey, normalized, perfConfig);
        }

        return normalized;
      })
      .finally(() => {
        this.inFlightLlm.delete(cacheKey);
      });

    this.inFlightLlm.set(cacheKey, task);
    return await task;
  }

  private setLlmCache(key: string, value: string, perfConfig: InlinePerformanceConfig): void {
    if (this.llmCache.size >= perfConfig.cacheMaxEntries) {
      const oldest = this.llmCache.keys().next().value;
      if (oldest) {
        this.llmCache.delete(oldest);
      }
    }

    this.llmCache.set(key, {
      value,
      expiresAt: Date.now() + perfConfig.cacheTtlMs
    });
  }

  private resolveInlinePerfConfig(): InlinePerformanceConfig {
    const raw = this.getInlinePerfConfig?.();
    if (!raw) {
      return {
        debounceMs: DEFAULT_DEBOUNCE_MS,
        llmBudgetMs: DEFAULT_FAST_LLM_BUDGET_MS,
        cacheTtlMs: DEFAULT_INLINE_CACHE_TTL_MS,
        cacheMaxEntries: DEFAULT_INLINE_CACHE_MAX_ENTRIES
      };
    }

    return {
      debounceMs: normalizeNumber(raw.debounceMs, 20, 500, DEFAULT_DEBOUNCE_MS),
      llmBudgetMs: normalizeNumber(raw.llmBudgetMs, 300, 5000, DEFAULT_FAST_LLM_BUDGET_MS),
      cacheTtlMs: normalizeNumber(raw.cacheTtlMs, 1000, 120000, DEFAULT_INLINE_CACHE_TTL_MS),
      cacheMaxEntries: normalizeNumber(raw.cacheMaxEntries, 20, 1000, DEFAULT_INLINE_CACHE_MAX_ENTRIES)
    };
  }

  private buildDiagnosticInlineItem(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.InlineCompletionItem | undefined {
    const mode = this.getInlineDiagnosticFixMode?.() ?? 'errorAndWarning';
    const fixes = computeDiagnosticLineFixes(document, position.line);
    if (fixes.length === 0) {
      return undefined;
    }

    const hasError = this.hasLineDiagnostic(document, position.line, 'errorOnly');
    const hasWarnOrError = this.hasLineDiagnostic(document, position.line, 'errorAndWarning');

    if (mode === 'always') {
      // In always mode, only show structural fixes without diagnostics to avoid sticky indentation suggestions.
      const structuralFix = fixes.find((fix) => fix.title.includes('Fix merged keywords'));
      if (!structuralFix && !hasWarnOrError) {
        return undefined;
      }

      const lineRange = document.lineAt(position.line).range;
      return new vscode.InlineCompletionItem((structuralFix ?? fixes[0]).nextLineText, lineRange);
    }

    const hasLineDiagnostic = mode === 'errorOnly' ? hasError : hasWarnOrError;

    if (!hasLineDiagnostic) {
      return undefined;
    }

    const lineRange = document.lineAt(position.line).range;
    return new vscode.InlineCompletionItem(fixes[0].nextLineText, lineRange);
  }

  private hasLineDiagnostic(
    document: vscode.TextDocument,
    line: number,
    mode: Exclude<InlineDiagnosticFixMode, 'always'>
  ): boolean {
    return vscode.languages
      .getDiagnostics(document.uri)
      .some((diagnostic) => {
        if (mode === 'errorOnly' && diagnostic.severity !== vscode.DiagnosticSeverity.Error) {
          return false;
        }

        if (
          mode === 'errorAndWarning' &&
          diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
          diagnostic.severity !== vscode.DiagnosticSeverity.Warning
        ) {
          return false;
        }

        return diagnostic.range.start.line <= line && diagnostic.range.end.line >= line;
      });
  }

  private createInlineRequestKey(
    document: vscode.TextDocument,
    position: vscode.Position,
    linePrefix: string,
    attachedFiles: AttachedFileContext[]
  ): string {
    const attachmentPart = attachedFiles
      .slice(0, 1)
      .map((file) => `${file.path}:${file.content.length}`)
      .join('|');

    return [
      document.uri.toString(),
      document.languageId,
      String(position.line),
      linePrefix.trim(),
      attachmentPart
    ].join('::');
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

  let continuation = withoutFence;
  const trimmedPrefix = prefix.trim();
  if (trimmedPrefix && continuation.startsWith(trimmedPrefix)) {
    continuation = continuation.slice(trimmedPrefix.length).trimStart();
  }

  continuation = removeAdjacentDuplicateLines(continuation);
  continuation = removeRepeatedStructuralLines(continuation);
  continuation = collapseRepeatedReturnFragments(continuation);

  const lines = continuation
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index) => line.length > 0 || index === 0)
    .slice(0, 6);

  const joined = lines.join('\n').trim();
  if (!joined) {
    return undefined;
  }

  return joined.length > 480 ? joined.slice(0, 480).trimEnd() : joined;
}

function vetInlineSuggestion(prefix: string, suggestion: string | undefined, languageId: string): string | undefined {
  if (!suggestion) {
    return undefined;
  }

  let next = enforceKeywordSpacing(prefix, suggestion, languageId);
  if (!next) {
    return undefined;
  }

  const sanitized = applyLanguageSpecificSanitization(next, languageId);
  if (!sanitized) {
    return undefined;
  }
  next = sanitized;

  if (looksLikePromptLeak(next)) {
    return undefined;
  }

  if (looksLikeMalformedMerge(next, languageId)) {
    return undefined;
  }

  if (languageId === 'python' && hasMalformedPythonStructure(next)) {
    return undefined;
  }

  const compact = next.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return undefined;
  }

  // Keep inline ghost text focused while still allowing small multi-line completions.
  if (next.length > 480) {
    next = next.slice(0, 480).trimEnd();
  }

  return next;
}

function applyLanguageSpecificSanitization(suggestion: string, languageId: string): string | undefined {
  let next = suggestion;

  if (languageId === 'python') {
    // Split merged decorator/function declarations and normalize import list spacing.
    next = next.replace(/(@[^\n]+)\s+def\s+/g, '$1\ndef ');
    next = next.replace(/(\[[^\]]*\])\s*def\s+/g, '$1\ndef ');
    next = next.replace(/(\bfrom\s+[A-Za-z0-9_.]+\s+import\s+[^\n,]+),(\S)/g, '$1, $2');
    next = normalizeDuplicatePythonCalls(next);

    // Avoid obviously invalid mixed-scope output like decorator and def glued mid-line.
    if (/\S@app\.route\(/.test(next) || /\)def\s+/.test(next)) {
      return undefined;
    }
  }

  return next;
}

function hasMalformedPythonStructure(text: string): boolean {
  const lines = text.split('\n');
  let previousSignificant = '';
  let previousIndent = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }

    const indent = getLeadingWhitespace(raw).length;

    if (trimmed.startsWith('def ') && indent > 0) {
      const followsBlockOpener = previousSignificant.endsWith(':');
      const becameMoreIndented = indent > previousIndent;
      if (!followsBlockOpener || !becameMoreIndented) {
        return true;
      }
    }

    if (/^\w+\(\)$/.test(trimmed) && previousSignificant === trimmed) {
      return true;
    }

    previousSignificant = trimmed;
    previousIndent = indent;
  }

  return false;
}

function normalizeDuplicatePythonCalls(text: string): string {
  const seen = new Set<string>();

  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!/^\w+\(\)$/.test(trimmed)) {
        return true;
      }

      if (seen.has(trimmed)) {
        return false;
      }

      seen.add(trimmed);
      return true;
    })
    .join('\n');
}

function removeAdjacentDuplicateLines(text: string): string {
  const lines = text.split('\n');
  const deduped: string[] = [];

  for (const line of lines) {
    const compact = line.trim();
    const prev = deduped.length > 0 ? deduped[deduped.length - 1].trim() : undefined;
    if (compact.length > 0 && prev === compact) {
      continue;
    }

    deduped.push(line);
  }

  return deduped.join('\n');
}

function collapseRepeatedReturnFragments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let next = line;
      next = next.replace(/(\breturn\s+"[^"]+")(?:\s+\1)+/g, '$1');
      next = next.replace(/(\breturn\s+'[^']+')(?:\s+\1)+/g, '$1');
      next = next.replace(/(\breturn\s+`[^`]+`)(?:\s+\1)+/g, '$1');
      return next;
    })
    .join('\n');
}

function removeRepeatedStructuralLines(text: string): string {
  const seen = new Set<string>();

  return text
    .split('\n')
    .filter((line) => {
      const compact = line.trim();
      if (!compact) {
        return true;
      }

      if (/^(return\s+|@|def\s+|class\s+|from\s+.+\s+import\s+|import\s+)/.test(compact)) {
        if (seen.has(compact)) {
          return false;
        }

        seen.add(compact);
      }

      return true;
    })
    .join('\n');
}

function enforceKeywordSpacing(prefix: string, suggestion: string, languageId: string): string {
  const trimmedPrefix = prefix.trimEnd();
  const first = suggestion[0] ?? '';
  const keyword = getKeywordNeedingGap(trimmedPrefix, languageId);

  if (keyword && /[A-Za-z0-9_]/.test(first)) {
    return ` ${suggestion}`;
  }

  return suggestion;
}

function getKeywordNeedingGap(prefix: string, languageId: string): string | undefined {
  const common = ['import', 'from', 'class', 'return'];
  const python = ['def', 'elif', 'except', 'with', 'as'];
  const jsTs = ['const', 'let', 'var', 'function', 'interface', 'type', 'export'];
  const javaLike = ['package', 'public', 'private', 'protected', 'static', 'new'];

  const keywords = new Set<string>(common);
  if (languageId === 'python') {
    for (const value of python) {
      keywords.add(value);
    }
  }
  if (languageId === 'javascript' || languageId === 'javascriptreact' || languageId === 'typescript' || languageId === 'typescriptreact') {
    for (const value of jsTs) {
      keywords.add(value);
    }
  }
  if (languageId === 'java' || languageId === 'csharp' || languageId === 'kotlin') {
    for (const value of javaLike) {
      keywords.add(value);
    }
  }

  for (const keyword of keywords) {
    if (prefix.endsWith(keyword) && !prefix.endsWith(`${keyword} `)) {
      return keyword;
    }
  }

  return undefined;
}

function looksLikePromptLeak(suggestion: string): boolean {
  const lowered = suggestion.toLowerCase();
  return lowered.includes('current line prefix:') || lowered.includes('language:') || lowered.includes('return only the continuation');
}

function looksLikeMalformedMerge(suggestion: string, languageId: string): boolean {
  if (/\b(import|from|class|return|function|const|let|var|def|package)(?=[A-Za-z_])/i.test(suggestion)) {
    return true;
  }

  if (/(importfrom|fromimport|classdef|functionreturn|returnif)/i.test(suggestion.replace(/\s+/g, ''))) {
    return true;
  }

  if (languageId === 'python' && /[A-Za-z_]from\b|[A-Za-z_]import\b/.test(suggestion)) {
    return true;
  }

  return false;
}

function normalizeNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function shouldBlockSuggestionAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position,
  suggestion: string,
  languageId: string
): boolean {
  const firstLine = suggestion
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return true;
  }

  const currentPrefix = document.lineAt(position.line).text.slice(0, position.character);
  const currentIndent = getLeadingWhitespace(currentPrefix).length;

  if (languageId === 'python' && /^return\b/.test(firstLine) && currentIndent === 0) {
    return true;
  }

  if (isConsecutiveDuplicateStructuralLine(document, position.line, firstLine)) {
    return true;
  }

  return false;
}

function scoreInlineCandidate(
  source: 'llm' | 'local' | 'fix',
  text: string,
  document: vscode.TextDocument,
  position: vscode.Position
): number {
  let score = source === 'llm' ? 60 : source === 'local' ? 45 : 35;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return -1000;
  }

  if (trimmed.length <= 180) {
    score += 4;
  }

  const lineCount = text.split('\n').length;
  if (lineCount > 1 && lineCount <= 4) {
    score += 5;
  }
  if (lineCount > 6) {
    score -= 8;
  }

  if (hasConsecutiveDuplicateWord(trimmed)) {
    score -= 12;
  }

  if (isConsecutiveDuplicateStructuralLine(document, position.line, trimmed.split('\n')[0]?.trim() ?? '')) {
    score -= 14;
  }

  if (source === 'fix' && !/^(import\b|from\b|@|def\b|class\b|return\b)/.test(trimmed)) {
    score -= 6;
  }

  return score;
}

function hasConsecutiveDuplicateWord(text: string): boolean {
  return /\b([A-Za-z_][A-Za-z0-9_]*)\s+\1\b/.test(text);
}

function isConsecutiveDuplicateStructuralLine(
  document: vscode.TextDocument,
  line: number,
  firstSuggestionLine: string
): boolean {
  if (!/^(return\b|import\b|from\b|@|def\b|class\b)/.test(firstSuggestionLine)) {
    return false;
  }

  for (let index = line - 1; index >= 0; index -= 1) {
    const previous = document.lineAt(index).text.trim();
    if (!previous) {
      continue;
    }

    return previous === firstSuggestionLine;
  }

  return false;
}

function getLeadingWhitespace(value: string): string {
  const match = value.match(/^\s*/);
  return match ? match[0] : '';
}
