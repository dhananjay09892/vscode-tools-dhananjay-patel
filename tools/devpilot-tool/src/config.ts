import * as vscode from 'vscode';

export type DevpilotChatMode = 'chat' | 'agent' | 'plan';
export type ToolApprovalScope = 'askEveryTime' | 'allowSession' | 'allowWorkspace';
export type InlineDiagnosticFixMode = 'errorOnly' | 'errorAndWarning' | 'always';
export type InlineContextMode = 'window' | 'fullFileWhenSmall';

export interface ToolApprovalConfig {
  defaultReadScope: ToolApprovalScope;
  defaultWriteScope: ToolApprovalScope;
  defaultExecuteScope: ToolApprovalScope;
  defaultBrowserScope: ToolApprovalScope;
  defaultNetworkScope: ToolApprovalScope;
  workspaceAllowedTools: string[];
}

export interface ARIAConfig {
  provider: string;
  model: string;
  inlineFastModelOverride: string;
  inlineDebounceMs: number;
  inlineLlmBudgetMs: number;
  inlineCacheTtlMs: number;
  inlineCacheMaxEntries: number;
  enabledTools: string[];
  chatMode: DevpilotChatMode;
  autoAttachCurrentFile: boolean;
  agentAllowFileWrites: boolean;
  endpoint: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  groqBaseUrl: string;
  openrouterBaseUrl: string;
  ollamaBaseUrl: string;
  requestTimeoutMs: number;
  enableGuardrails: boolean;
  inlineLlmEnabled: boolean;
  inlineDiagnosticFixMode: InlineDiagnosticFixMode;
  inlineContextMode: InlineContextMode;
  inlineMaxFileChars: number;
  inlineIncludeImportedFiles: boolean;
  inlineImportedFilesLimit: number;
  quickFixEnabled: boolean;
  agentToolWorkspaceAllowed: string[];
  toolApproval: ToolApprovalConfig;
  toolAuditMaxEntries: number;
}

const DEFAULT_TIMEOUT_MS = 20000;

function normalizeToolApprovalScope(value: string): ToolApprovalScope {
  if (value === 'allowSession' || value === 'allowWorkspace') {
    return value;
  }

  return 'askEveryTime';
}

function normalizeChatMode(value: string): DevpilotChatMode {
  if (value === 'agent' || value === 'plan') {
    return value;
  }

  return 'chat';
}

function normalizeInlineDiagnosticFixMode(value: string): InlineDiagnosticFixMode {
  if (value === 'errorOnly' || value === 'errorAndWarning' || value === 'always') {
    return value;
  }

  return 'always';
}

function normalizeInlineContextMode(value: string): InlineContextMode {
  if (value === 'window' || value === 'fullFileWhenSmall') {
    return value;
  }

  return 'fullFileWhenSmall';
}

export function getDevpilotConfig(): ARIAConfig {
  const cfg = vscode.workspace.getConfiguration('devpilot');

  const provider = cfg.get<string>('provider', 'local').trim().toLowerCase() || 'local';
  const model = cfg.get<string>('model', 'aria-local-backend-v1').trim() || 'aria-local-backend-v1';
  const inlineFastModelOverride = cfg.get<string>('inlineFastModelOverride', '').trim();
  const inlineDebounceMs = normalizeBoundedInt(cfg.get<number>('inlineDebounceMs', 90), 20, 500, 90);
  const inlineLlmBudgetMs = normalizeBoundedInt(cfg.get<number>('inlineLlmBudgetMs', 1200), 300, 5000, 1200);
  const inlineCacheTtlMs = normalizeBoundedInt(cfg.get<number>('inlineCacheTtlMs', 15000), 1000, 120000, 15000);
  const inlineCacheMaxEntries = normalizeBoundedInt(cfg.get<number>('inlineCacheMaxEntries', 200), 20, 1000, 200);
  const enabledTools = cfg.get<string[]>(
    'enabledTools',
    ['create_directory', 'create_file', 'edit_file', 'write_file', 'replace_in_file', 'rename_file', 'search_workspace']
  );
  const chatMode = normalizeChatMode(cfg.get<string>('chatMode', 'chat').trim().toLowerCase());
  const autoAttachCurrentFile = cfg.get<boolean>('autoAttachCurrentFile', true);
  const agentAllowFileWrites = cfg.get<boolean>('agentAllowFileWrites', false);
  const endpoint = cfg.get<string>('endpoint', '').trim();
  const openaiBaseUrl = cfg.get<string>('openaiBaseUrl', 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1';
  const anthropicBaseUrl = cfg.get<string>('anthropicBaseUrl', 'https://api.anthropic.com/v1').trim() || 'https://api.anthropic.com/v1';
  const groqBaseUrl = cfg.get<string>('groqBaseUrl', 'https://api.groq.com/openai/v1').trim() || 'https://api.groq.com/openai/v1';
  const openrouterBaseUrl = cfg.get<string>('openrouterBaseUrl', 'https://openrouter.ai/api/v1').trim() || 'https://openrouter.ai/api/v1';
  const ollamaBaseUrl = cfg.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434').trim() || 'http://127.0.0.1:11434';
  const requestTimeoutRaw = cfg.get<number>('requestTimeoutMs', DEFAULT_TIMEOUT_MS);
  const requestTimeoutMs = Number.isFinite(requestTimeoutRaw)
    ? Math.max(1000, Math.trunc(requestTimeoutRaw))
    : DEFAULT_TIMEOUT_MS;
  const enableGuardrails = cfg.get<boolean>('enableGuardrails', true);
  const inlineLlmEnabled = cfg.get<boolean>('inlineLlmEnabled', true);
  const quickFixEnabled = cfg.get<boolean>('quickFixEnabled', false);
  const inlineContextMode = normalizeInlineContextMode(cfg.get<string>('inlineContextMode', 'fullFileWhenSmall').trim());
  const inlineMaxFileChars = normalizeBoundedInt(cfg.get<number>('inlineMaxFileChars', 18000), 4000, 120000, 18000);
  const inlineIncludeImportedFiles = cfg.get<boolean>('inlineIncludeImportedFiles', true);
  const inlineImportedFilesLimit = normalizeBoundedInt(cfg.get<number>('inlineImportedFilesLimit', 2), 0, 6, 2);
  const inlineDiagnosticFixMode = normalizeInlineDiagnosticFixMode(
    cfg.get<string>('inlineDiagnosticFixMode', 'always').trim()
  );
  const agentToolWorkspaceAllowed = cfg.get<string[]>('agentToolWorkspaceAllowed', []);
  const defaultReadScope = normalizeToolApprovalScope(cfg.get<string>('toolApproval.defaultReadScope', 'allowSession'));
  const defaultWriteScope = normalizeToolApprovalScope(cfg.get<string>('toolApproval.defaultWriteScope', 'askEveryTime'));
  const defaultExecuteScope = normalizeToolApprovalScope(cfg.get<string>('toolApproval.defaultExecuteScope', 'askEveryTime'));
  const defaultBrowserScope = normalizeToolApprovalScope(cfg.get<string>('toolApproval.defaultBrowserScope', 'askEveryTime'));
  const defaultNetworkScope = normalizeToolApprovalScope(cfg.get<string>('toolApproval.defaultNetworkScope', 'askEveryTime'));
  const workspaceAllowedTools = cfg.get<string[]>('toolApproval.workspaceAllowedTools', []);
  const toolAuditMaxEntriesRaw = cfg.get<number>('toolAudit.maxEntries', 200);
  const toolAuditMaxEntries = Number.isFinite(toolAuditMaxEntriesRaw)
    ? Math.max(50, Math.trunc(toolAuditMaxEntriesRaw))
    : 200;

  return {
    provider,
    model,
    inlineFastModelOverride,
    inlineDebounceMs,
    inlineLlmBudgetMs,
    inlineCacheTtlMs,
    inlineCacheMaxEntries,
    enabledTools,
    chatMode,
    autoAttachCurrentFile,
    agentAllowFileWrites,
    endpoint,
    openaiBaseUrl,
    anthropicBaseUrl,
    groqBaseUrl,
    openrouterBaseUrl,
    ollamaBaseUrl,
    requestTimeoutMs,
    enableGuardrails,
    inlineLlmEnabled,
    inlineDiagnosticFixMode,
    inlineContextMode,
    inlineMaxFileChars,
    inlineIncludeImportedFiles,
    inlineImportedFilesLimit,
    quickFixEnabled,
    agentToolWorkspaceAllowed,
    toolApproval: {
      defaultReadScope,
      defaultWriteScope,
      defaultExecuteScope,
      defaultBrowserScope,
      defaultNetworkScope,
      workspaceAllowedTools
    },
    toolAuditMaxEntries
  };
}

function normalizeBoundedInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return Math.min(max, Math.max(min, normalized));
}

export function resolveChatEndpoint(config: ARIAConfig, localBackendBaseUrl: string): string {
  const custom = config.endpoint;
  if (!custom) {
    return `${localBackendBaseUrl}/chat`;
  }

  if (custom.endsWith('/chat')) {
    return custom;
  }

  if (custom.endsWith('/')) {
    return `${custom}chat`;
  }

  return `${custom}/chat`;
}
