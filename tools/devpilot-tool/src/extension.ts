import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatContextPayload, ChatRequestPayload, ChatResponsePayload, startChatBackend } from './chatBackend';
import { collectChatContext } from './contextCollector';
import { AttachedFileContext, InlineLlmSuggestionRequest, registerInlineCompletionProvider } from './inlineCompletion';
import { DevpilotChatMode, getDevpilotConfig, resolveChatEndpoint } from './config';
import { sanitizeContext, sanitizePrompt } from './guardrails';
import { createLogger } from './logger';
import { buildQuickActionItems, toUserFriendlyError } from './commandUtils';
import {
  createProviderClient,
  getProviderDescriptor,
  isSupportedProviderId,
  listSupportedProviders,
  SupportedProviderId
} from './llm/providerRegistry';
import { LlmProviderClient } from './llm/types';

const PANEL_ID = 'devpilot.chatPanel';
const PANEL_TITLE = 'Devpilot Chat';
const CHAT_VIEW_ID = 'devpilot.chatView';
const CHAT_CONTAINER_ID = 'workbench.view.extension.devpilot';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const INLINE_TIMEOUT_MS = 2500;
const COMMAND_ANALYZE = 'devpilot.analyzeCurrentFile';
const COMMAND_EXPLAIN = 'devpilot.explainSelection';
const COMMAND_TESTS = 'devpilot.generateTests';
const COMMAND_REFACTOR = 'devpilot.refactorSuggestion';
const COMMAND_QUICK_ACTIONS = 'devpilot.quickActions';
const COMMAND_CONFIGURE_LLM = 'devpilot.configureLlm';
const COMMAND_OPEN_SETTINGS = 'devpilot.openSettings';
const COMMAND_CONFIGURE_TOOLS = 'devpilot.configureTools';
const COMMAND_ATTACH_FILES = 'devpilot.attachFiles';
const COMMAND_TOGGLE_INLINE = 'devpilot.toggleInlineSuggestions';
const SECRET_API_KEY = 'devpilot.apiKey';
const SECRET_SESSION_TOKEN = 'devpilot.sessionToken';
const SECRET_OPENAI_API_KEY = 'devpilot.provider.openai.apiKey';
const SECRET_ANTHROPIC_API_KEY = 'devpilot.provider.anthropic.apiKey';
const SECRET_GROQ_API_KEY = 'devpilot.provider.groq.apiKey';
const SECRET_OPENROUTER_API_KEY = 'devpilot.provider.openrouter.apiKey';

type AgentToolAction =
  | { type: 'write_file'; path: string; content: string }
  | { type: 'replace_in_file'; path: string; search: string; replace: string }
  | { type: 'create_directory' | 'createDirectory'; path: string }
  | { type: 'create_file' | 'createFile'; path: string; content: string }
  | { type: 'create_jupyter_notebook' | 'createJupyterNotebook'; path: string }
  | { type: 'edit_file' | 'editFiles'; path: string; content: string }
  | { type: 'rename_file' | 'rename'; path: string; newPath: string }
  | { type: 'open_browser_page' | 'openBrowserPage'; url: string }
  | { type: 'navigate_page' | 'navigatePage'; pageId: string; navType?: 'url' | 'back' | 'forward' | 'reload'; url?: string }
  | { type: 'read_page' | 'readPage'; pageId: string }
  | { type: 'screenshot_page' | 'screenshotPage'; pageId: string }
  | { type: 'type_in_page' | 'typeInPage'; pageId: string; text?: string; key?: string }
  | { type: 'hover_element' | 'hoverElement'; pageId: string; selector?: string }
  | { type: 'run_playwright_code' | 'runPlaywrightCode'; pageId: string; code?: string };

interface AgentToolEnvelope {
  actions: AgentToolAction[];
}

interface ConfigurableTool {
  id: string;
  category: string;
  label: string;
  description: string;
}

interface BrowserSession {
  id: string;
  currentUrl: string;
  history: string[];
  historyIndex: number;
  lastHtml?: string;
  lastContent?: string;
  interactionLog: string[];
  runtimeMode: 'playwright' | 'snapshot';
  browser?: unknown;
  page?: unknown;
}

const BROWSER_SESSIONS = new Map<string, BrowserSession>();
const WRITE_TOOL_IDS = new Set<string>([
  'create_directory',
  'create_file',
  'create_jupyter_notebook',
  'edit_file',
  'write_file',
  'replace_in_file',
  'rename_file'
]);

const CONFIGURABLE_TOOLS: ConfigurableTool[] = [
  { id: 'create_directory', category: 'Built-In', label: 'createDirectory', description: 'Create new directories in your workspace' },
  { id: 'create_file', category: 'Built-In', label: 'createFile', description: 'Create new files in your workspace' },
  { id: 'create_jupyter_notebook', category: 'Built-In', label: 'createJupyterNotebook', description: 'Create a new Jupyter notebook file' },
  { id: 'edit_file', category: 'Built-In', label: 'editFiles', description: 'Edit files by replacing full file content' },
  { id: 'write_file', category: 'Built-In', label: 'writeFile', description: 'Write full file content in your workspace' },
  { id: 'replace_in_file', category: 'Built-In', label: 'editInline', description: 'Replace exact text in a file in your workspace' },
  { id: 'rename_file', category: 'Built-In', label: 'rename', description: 'Rename or move a file within your workspace' },
  { id: 'open_browser_page', category: 'Browser', label: 'openBrowserPage', description: 'Open a URL in the browser and create a page session' },
  { id: 'navigate_page', category: 'Browser', label: 'navigatePage', description: 'Navigate or reload a tracked page session' },
  { id: 'read_page', category: 'Browser', label: 'readPage', description: 'Fetch readable text content for a tracked page session' },
  { id: 'screenshot_page', category: 'Browser', label: 'screenshotPage', description: 'Capture page screenshot (Playwright runtime when available)' },
  { id: 'type_in_page', category: 'Browser', label: 'typeInPage', description: 'Type text or key into a page selector/focused element' },
  { id: 'hover_element', category: 'Browser', label: 'hoverElement', description: 'Hover over a selector on page' },
  { id: 'run_playwright_code', category: 'Browser', label: 'runPlaywrightCode', description: 'Execute advanced browser code in Playwright runtime' }
];

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Devpilot');
  const logger = createLogger(output);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = COMMAND_QUICK_ACTIONS;
  statusBar.tooltip = 'Devpilot quick actions';
  statusBar.show();
  setStatusBar(statusBar, 'starting');

  const backendReady = startChatBackend();
  backendReady
    .then(() => {
      setStatusBar(statusBar, 'ready');
      logger.info('backend.ready');
    })
    .catch((error) => {
      setStatusBar(statusBar, 'error');
      logger.error('backend.start_failed', { reason: toErrorMessage(error) });
    });

  context.subscriptions.push({
    dispose: () => {
      backendReady
        .then((backend) => backend.dispose())
        .catch(() => {
          // Best-effort shutdown only.
        });
    }
  });

  context.subscriptions.push({
    dispose: () => {
      void disposeAllBrowserSessions();
    }
  });

  let attachedFiles: AttachedFileContext[] = [];

  const bindChatWebview = (webview: vscode.Webview): void => {
    let provider: SupportedProviderId = getCurrentProviderId(getDevpilotConfig().provider);
    let mode: DevpilotChatMode = getDevpilotConfig().chatMode;
    let autoAttachCurrentFile = getDevpilotConfig().autoAttachCurrentFile;
    const providers = listSupportedProviders().map((item) => ({ id: item.id, label: item.label }));

    webview.html = getWebviewHtml();

    const publishUiState = () => {
      webview.postMessage({
        type: 'uiState',
        provider,
        providers,
        mode,
        autoAttachCurrentFile,
        files: attachedFiles.map((file) => file.path)
      });
    };

    publishUiState();

    webview.onDidReceiveMessage(
      async (message: { type: string; text?: string; provider?: string; mode?: string; autoAttachCurrentFile?: boolean }) => {
        if (message.type === 'attachFiles') {
          attachedFiles = await pickAndAttachFiles();
          publishUiState();
          return;
        }

        if (message.type === 'setProvider') {
          provider = getCurrentProviderId(message.provider);
          const cfg = vscode.workspace.getConfiguration('devpilot');
          await cfg.update('provider', provider, vscode.ConfigurationTarget.Global);
          publishUiState();
          return;
        }

        if (message.type === 'setMode') {
          mode = normalizeChatMode(message.mode);
          const cfg = vscode.workspace.getConfiguration('devpilot');
          await cfg.update('chatMode', mode, vscode.ConfigurationTarget.Global);
          publishUiState();
          return;
        }

        if (message.type === 'setAutoAttachCurrentFile') {
          autoAttachCurrentFile = message.autoAttachCurrentFile === true;
          const cfg = vscode.workspace.getConfiguration('devpilot');
          await cfg.update('autoAttachCurrentFile', autoAttachCurrentFile, vscode.ConfigurationTarget.Global);
          publishUiState();
          return;
        }

        if (message.type !== 'prompt') {
          return;
        }

        const config = getDevpilotConfig();
        provider = getCurrentProviderId(config.provider);
        mode = normalizeChatMode(config.chatMode);
        autoAttachCurrentFile = config.autoAttachCurrentFile;

        const promptRaw = (message.text ?? '').trim();
        const prompt = config.enableGuardrails ? sanitizePrompt(promptRaw) : promptRaw;
        if (!prompt) {
          webview.postMessage({
            type: 'answer',
            text: 'Please type a message so Devpilot can respond.'
          });
          return;
        }

        webview.postMessage({ type: 'answer', text: 'Sending prompt to Devpilot backend...' });
        setStatusBar(statusBar, 'working');

        try {
          const contextRaw = await collectChatContext();
          const contextPayload = config.enableGuardrails ? sanitizeContext(contextRaw) : contextRaw;
          const activeEditorAttachment = autoAttachCurrentFile
            ? await getActiveEditorAttachment(attachedFiles.map((file) => file.path))
            : undefined;
          const finalAttachments = activeEditorAttachment
            ? [...attachedFiles, activeEditorAttachment]
            : attachedFiles;
          const modePrompt = applyModeToPrompt(prompt, mode);

          const payload: ChatRequestPayload = {
            prompt: enrichPromptWithAttachments(modePrompt, finalAttachments),
            context: contextPayload
          };

          const response = await requestChatAnswer(config, payload, backendReady, context.secrets);

          let toolExecutionSummary = '';
          if (mode === 'agent') {
            const execution = await maybeRunAgentTools(response.answer, config.agentAllowFileWrites, config.enabledTools);
            if (execution.executedCount > 0 || execution.skippedReason) {
              toolExecutionSummary = [
                '',
                'Agent tool execution:',
                execution.executedCount > 0
                  ? `Applied ${execution.executedCount} action(s): ${execution.executed.join(', ')}`
                  : `No actions applied: ${execution.skippedReason ?? 'not requested'}`
              ].join('\n');
            }
          }

          webview.postMessage({ type: 'answer', text: `${response.answer}${toolExecutionSummary}` });
          logger.info('chat.request_succeeded', {
            requestId: response.requestId,
            model: config.model,
            provider: getCurrentProviderId(config.provider)
          });
          setStatusBar(statusBar, 'ready');
        } catch (error) {
          const messageText = toErrorMessage(error);
          const friendly = toUserFriendlyError(messageText, { providerId: config.provider });
          webview.postMessage({
            type: 'answer',
            text: [
              'Devpilot backend request failed.',
              `Provider: ${getCurrentProviderId(config.provider)}`,
              `Reason: ${friendly}`,
              'Tip: Use Devpilot: Configure LLM to verify provider/model and credentials.'
            ].join('\n')
          });
          logger.error('chat.request_failed', {
            reason: messageText,
            provider: getCurrentProviderId(config.provider),
            providerBaseUrl: resolveProviderBaseUrl(config)
          });
          output.show(true);
          setStatusBar(statusBar, 'error');
        }
      },
      undefined,
      context.subscriptions
    );
  };

  const sidebarChatProvider = vscode.window.registerWebviewViewProvider(
    CHAT_VIEW_ID,
    {
      resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: true };
        bindChatWebview(webviewView.webview);
      }
    },
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  const openChat = vscode.commands.registerCommand('devpilot.openChat', async () => {
    try {
      await vscode.commands.executeCommand(CHAT_CONTAINER_ID);
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    } catch {
      // Fallback to tab panel if view-container command is unavailable.
      const panel = vscode.window.createWebviewPanel(
        PANEL_ID,
        PANEL_TITLE,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      bindChatWebview(panel.webview);
    }
  });

  const quickActions = vscode.commands.registerCommand(COMMAND_QUICK_ACTIONS, async () => {
    const picked = await vscode.window.showQuickPick(
      buildQuickActionItems(),
      {
        placeHolder: 'Choose a Devpilot action'
      }
    );

    if (!picked) {
      return;
    }

    await vscode.commands.executeCommand(picked.command);
  });

  const configureLlm = vscode.commands.registerCommand(COMMAND_CONFIGURE_LLM, async () => {
    await runConfigureLlmCommand(context.secrets, logger);
  });

  const openSettings = vscode.commands.registerCommand(COMMAND_OPEN_SETTINGS, async () => {
    await openSettingsPanel(context.secrets, logger);
  });

  const configureTools = vscode.commands.registerCommand(COMMAND_CONFIGURE_TOOLS, async () => {
    await runConfigureToolsCommand(logger);
  });

  const attachFiles = vscode.commands.registerCommand(COMMAND_ATTACH_FILES, async () => {
    attachedFiles = await pickAndAttachFiles();
    const count = attachedFiles.length;
    if (count > 0) {
      vscode.window.showInformationMessage(`Devpilot: attached ${count} file(s). They will be used in chat and inline suggestions.`);
    }
  });

  const toggleInlineSuggestions = vscode.commands.registerCommand(COMMAND_TOGGLE_INLINE, async () => {
    const cfg = vscode.workspace.getConfiguration('devpilot');
    const current = cfg.get<boolean>('inlineLlmEnabled', true);
    const next = !current;
    await cfg.update('inlineLlmEnabled', next, vscode.ConfigurationTarget.Global);
    setStatusBar(statusBar, 'ready');
    const stateLabel = next ? 'ON' : 'OFF';
    vscode.window.showInformationMessage(`Devpilot inline suggestions: ${stateLabel}`);
  });

  const analyzeCurrentFile = vscode.commands.registerCommand(COMMAND_ANALYZE, async () => {
    await runDeveloperCommand(
      'Analyze Current File',
      'Analyze the active file and summarize architecture, responsibilities, dependencies, and top risks.',
      backendReady,
      context.secrets,
      logger,
      output,
      statusBar,
      false
    );
  });

  const explainSelection = vscode.commands.registerCommand(COMMAND_EXPLAIN, async () => {
    await runDeveloperCommand(
      'Explain Selection',
      'Explain the selected code in detail: what it does, edge cases, and potential issues.',
      backendReady,
      context.secrets,
      logger,
      output,
      statusBar,
      true
    );
  });

  const generateTests = vscode.commands.registerCommand(COMMAND_TESTS, async () => {
    await runDeveloperCommand(
      'Generate Tests',
      'Generate practical unit test ideas and sample test cases for this file/selection.',
      backendReady,
      context.secrets,
      logger,
      output,
      statusBar,
      false
    );
  });

  const refactorSuggestion = vscode.commands.registerCommand(COMMAND_REFACTOR, async () => {
    await runDeveloperCommand(
      'Refactor Suggestion',
      'Suggest a safe refactor plan with before/after strategy and risk notes.',
      backendReady,
      context.secrets,
      logger,
      output,
      statusBar,
      false
    );
  });

  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('devpilot.inlineLlmEnabled') ||
      event.affectsConfiguration('devpilot.inlineFastModelOverride') ||
      event.affectsConfiguration('devpilot.provider') ||
      event.affectsConfiguration('devpilot.chatMode') ||
      event.affectsConfiguration('devpilot.autoAttachCurrentFile')
    ) {
      setStatusBar(statusBar, 'ready');
    }
  });

  registerInlineCompletionProvider(
    context,
    statusBar,
    output,
    () => attachedFiles,
    async (request, token) => {
      if (token.isCancellationRequested) {
        return undefined;
      }

      const config = getDevpilotConfig();
      if (!config.inlineLlmEnabled) {
        return undefined;
      }

      const linePrefix = request.linePrefix.trim();
      if (linePrefix.length < 3) {
        return undefined;
      }

      try {
        const payload = buildInlineSuggestionPayload(request, config.enableGuardrails);
        return await requestInlineSuggestionAnswer(config, payload, backendReady, context.secrets, token);
      } catch {
        return undefined;
      }
    },
    () => getDevpilotConfig().inlineLlmEnabled
  );

  context.subscriptions.push(
    openChat,
    sidebarChatProvider,
    quickActions,
    openSettings,
    configureTools,
    attachFiles,
    toggleInlineSuggestions,
    configureLlm,
    analyzeCurrentFile,
    explainSelection,
    generateTests,
    refactorSuggestion,
    configWatcher,
    output,
    statusBar
  );
}

async function runDeveloperCommand(
  title: string,
  commandPrompt: string,
  backendReady: Promise<Awaited<ReturnType<typeof startChatBackend>>>,
  secrets: vscode.SecretStorage,
  logger: ReturnType<typeof createLogger>,
  output: vscode.OutputChannel,
  statusBar: vscode.StatusBarItem,
  requiresSelection: boolean
): Promise<void> {
  try {
    setStatusBar(statusBar, 'working');
    const config = getDevpilotConfig();
    const contextRaw = await collectChatContext();
    const contextPayload = config.enableGuardrails ? sanitizeContext(contextRaw) : contextRaw;

    if (requiresSelection && contextPayload.selectionSummary === 'Selection: (none)') {
      vscode.window.showWarningMessage('Devpilot: Select code first, then run Explain Selection.');
      return;
    }

    const prompt = config.enableGuardrails ? sanitizePrompt(commandPrompt) : commandPrompt;
    const payload: ChatRequestPayload = {
      prompt,
      context: contextPayload
    };

    const response = await requestChatAnswer(config, payload, backendReady, secrets);

    const rendered = formatCommandResult(title, payload, response);
    output.clear();
    output.appendLine(rendered);
    output.show(true);
    logger.info('command.succeeded', {
      title,
      requestId: response.requestId,
      provider: getCurrentProviderId(config.provider),
      model: response.model
    });
    setStatusBar(statusBar, 'ready');

    vscode.window.showInformationMessage(`Devpilot: ${title} completed. See Devpilot output channel.`);
  } catch (error) {
    const messageText = toErrorMessage(error);
    logger.error('command.failed', { title, reason: messageText });
    output.appendLine(`[devpilot] ${title} failed: ${messageText}`);
    output.show(true);
    setStatusBar(statusBar, 'error');
    vscode.window.showErrorMessage(
      `Devpilot: ${title} failed. ${toUserFriendlyError(messageText, { providerId: getCurrentProviderId(getDevpilotConfig().provider) })}`
    );
  }
}

function setStatusBar(statusBar: vscode.StatusBarItem, state: 'starting' | 'ready' | 'working' | 'error'): void {
  const config = getDevpilotConfig();
  const inlineEnabled = config.inlineLlmEnabled;
  const inlineState = inlineEnabled ? 'ON' : 'OFF';
  const autoAttachState = config.autoAttachCurrentFile ? 'ON' : 'OFF';
  statusBar.tooltip = `Devpilot quick actions\nMode: ${config.chatMode}\nInline suggestions: ${inlineState}\nAuto-attach current file: ${autoAttachState}`;

  if (state === 'starting') {
    statusBar.text = `$(sync~spin) Devpilot: Starting [Inline:${inlineState}]`;
    return;
  }

  if (state === 'ready') {
    statusBar.text = `$(check) Devpilot: Ready [Inline:${inlineState}]`;
    return;
  }

  if (state === 'working') {
    statusBar.text = `$(sync~spin) Devpilot: Working [Inline:${inlineState}]`;
    return;
  }

  statusBar.text = `$(error) Devpilot: Error [Inline:${inlineState}]`;
}

function formatCommandResult(
  title: string,
  payload: ChatRequestPayload,
  response: ChatResponsePayload
): string {
  return [
    `=== Devpilot Command: ${title} ===`,
    `Model: ${response.model}`,
    `Request ID: ${response.requestId}`,
    `Prompt: ${payload.prompt}`,
    `Active file: ${payload.context.activeFile}`,
    `Language: ${payload.context.languageId}`,
    `Cursor: ${payload.context.cursor}`,
    `Selection: ${payload.context.selectionRange}`,
    '',
    '--- Result ---',
    response.answer,
    '',
    '--- Context Summary ---',
    `Diagnostics:\n${payload.context.diagnosticsSummary}`,
    `Git diff:\n${payload.context.gitDiffSummary}`,
    `File content chars: ${payload.context.activeFileContent.length}`
  ].join('\n');
}

async function callChatApiWithRetry(
  url: string,
  payload: ChatRequestPayload,
  maxAttempts: number,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<ChatResponsePayload> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptTimeoutMs = computeAttemptTimeout(timeoutMs, attempt);

    try {
      return await postJsonWithTimeout(url, payload, attemptTimeoutMs, headers);
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        await delay(250 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Devpilot backend request failed.');
}

async function requestChatAnswer(
  config: ReturnType<typeof getDevpilotConfig>,
  payload: ChatRequestPayload,
  backendReady: Promise<Awaited<ReturnType<typeof startChatBackend>>>,
  secrets: vscode.SecretStorage
): Promise<ChatResponsePayload> {
  const providerId = getCurrentProviderId(config.provider);

  if (providerId === 'local') {
    const backend = await backendReady;
    const endpoint = resolveChatEndpoint(config, backend.baseUrl);
    const localFallbackEndpoint = `${backend.baseUrl}/chat`;
    const auth = await resolveLocalBackendAuthHeaders(secrets);

    try {
      return await callChatApiWithRetry(
        endpoint,
        payload,
        MAX_ATTEMPTS,
        config.requestTimeoutMs,
        auth.headers
      );
    } catch (error) {
      const messageText = toErrorMessage(error);
      if (messageText.includes('HTTP 404') && endpoint !== localFallbackEndpoint) {
        return await callChatApiWithRetry(
          localFallbackEndpoint,
          payload,
          MAX_ATTEMPTS,
          config.requestTimeoutMs,
          auth.headers
        );
      }

      throw error;
    }
  }

  const apiKey = await resolveProviderApiKey(providerId, secrets);
  const client = createProviderClient(providerId, {
    apiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    anthropicBaseUrl: config.anthropicBaseUrl,
    groqBaseUrl: config.groqBaseUrl,
    openrouterBaseUrl: config.openrouterBaseUrl,
    ollamaBaseUrl: config.ollamaBaseUrl
  });

  if (!client) {
    throw new Error(`No client available for provider: ${providerId}`);
  }

  return await callProviderWithRetry(client, payload, config.model, MAX_ATTEMPTS, config.requestTimeoutMs);
}

async function requestInlineSuggestionAnswer(
  config: ReturnType<typeof getDevpilotConfig>,
  payload: ChatRequestPayload,
  backendReady: Promise<Awaited<ReturnType<typeof startChatBackend>>>,
  secrets: vscode.SecretStorage,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  if (token.isCancellationRequested) {
    return undefined;
  }

  const timeoutMs = Math.min(INLINE_TIMEOUT_MS, config.requestTimeoutMs);
  const providerId = getCurrentProviderId(config.provider);

  if (providerId === 'local') {
    const backend = await backendReady;
    const endpoint = resolveChatEndpoint(config, backend.baseUrl);
    const localFallbackEndpoint = `${backend.baseUrl}/chat`;
    const auth = await resolveLocalBackendAuthHeaders(secrets);

    try {
      const response = await postJsonWithTimeout(endpoint, payload, timeoutMs, auth.headers, token);
      return response.answer;
    } catch (error) {
      const messageText = toErrorMessage(error);
      if (messageText.includes('HTTP 404') && endpoint !== localFallbackEndpoint) {
        const response = await postJsonWithTimeout(localFallbackEndpoint, payload, timeoutMs, auth.headers, token);
        return response.answer;
      }

      return undefined;
    }
  }

  const inlineModel = resolveInlineModelName(config);

  const apiKey = await resolveProviderApiKey(providerId, secrets);
  const client = createProviderClient(providerId, {
    apiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    anthropicBaseUrl: config.anthropicBaseUrl,
    groqBaseUrl: config.groqBaseUrl,
    openrouterBaseUrl: config.openrouterBaseUrl,
    ollamaBaseUrl: config.ollamaBaseUrl
  });

  if (!client) {
    return undefined;
  }

  try {
    const response = await callProviderWithTimeout(client, payload, inlineModel, timeoutMs, token);
    return response.answer;
  } catch {
    return undefined;
  }
}

function resolveInlineModelName(config: ReturnType<typeof getDevpilotConfig>): string {
  if (config.inlineFastModelOverride.trim().length > 0) {
    return config.inlineFastModelOverride.trim();
  }

  const providerId = getCurrentProviderId(config.provider);

  if (providerId === 'openai') {
    return 'gpt-4.1-mini';
  }

  if (providerId === 'anthropic') {
    return 'claude-3-5-haiku-latest';
  }

  if (providerId === 'groq') {
    return 'llama-3.1-8b-instant';
  }

  if (providerId === 'openrouter') {
    return 'openai/gpt-4o-mini';
  }

  if (providerId === 'ollama') {
    return 'llama3.1:8b';
  }

  return config.model;
}

async function callProviderWithRetry(
  client: LlmProviderClient,
  payload: ChatRequestPayload,
  model: string,
  maxAttempts: number,
  timeoutMs: number
): Promise<ChatResponsePayload> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptTimeoutMs = computeAttemptTimeout(timeoutMs, attempt);

    try {
      return await callProviderWithTimeout(client, payload, model, attemptTimeoutMs);
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        await delay(250 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Provider request failed.');
}

function computeAttemptTimeout(baseTimeoutMs: number, attempt: number): number {
  const scaled = baseTimeoutMs * attempt;
  return Math.min(60000, Math.max(1000, Math.trunc(scaled)));
}

async function callProviderWithTimeout(
  client: LlmProviderClient,
  payload: ChatRequestPayload,
  model: string,
  timeoutMs: number,
  cancelToken?: vscode.CancellationToken
): Promise<ChatResponsePayload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancelSubscription = cancelToken?.onCancellationRequested(() => controller.abort());

  try {
    const result = await client.chat(
      {
        prompt: payload.prompt,
        contextEnvelope: buildContextEnvelope(payload.context),
        model
      },
      controller.signal
    );

    return {
      answer: result.answer,
      model: result.model,
      requestId: result.requestId ?? `provider-${Date.now()}`
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    cancelSubscription?.dispose();
  }
}

function buildContextEnvelope(context: ChatContextPayload): string {
  return [
    'Context from VS Code:',
    `Active file: ${context.activeFile}`,
    `Language: ${context.languageId}`,
    `Cursor: ${context.cursor}`,
    context.selectionSummary,
    `Selection range: ${context.selectionRange}`,
    `Diagnostics:\n${context.diagnosticsSummary}`,
    `Git diff:\n${context.gitDiffSummary}`,
    `File content:\n${context.activeFileContent}`
  ].join('\n');
}

async function postJsonWithTimeout(
  url: string,
  payload: ChatRequestPayload,
  timeoutMs: number,
  headers?: Record<string, string>,
  cancelToken?: vscode.CancellationToken
): Promise<ChatResponsePayload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancelSubscription = cancelToken?.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return (await response.json()) as ChatResponsePayload;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    cancelSubscription?.dispose();
  }
}

async function resolveLocalBackendAuthHeaders(secrets: vscode.SecretStorage): Promise<{ headers: Record<string, string> }> {
  const apiKey = await secrets.get(SECRET_API_KEY);
  const token = await secrets.get(SECRET_SESSION_TOKEN);

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['X-Devpilot-Api-Key'] = apiKey;
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return { headers };
}

async function runConfigureLlmCommand(
  secrets: vscode.SecretStorage,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const providers = listSupportedProviders();
  const providerPick = await vscode.window.showQuickPick(
    providers.map((provider) => ({
      label: provider.label,
      description: provider.id,
      provider
    })),
    { placeHolder: 'Select LLM provider' }
  );

  if (!providerPick) {
    return;
  }

  const provider = providerPick.provider;
  const cfg = vscode.workspace.getConfiguration('devpilot');
  await cfg.update('provider', provider.id, vscode.ConfigurationTarget.Global);

  if (!provider.supportsRemoteModels) {
    await cfg.update('model', provider.defaultModel, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Devpilot: configured ${provider.label}.`);
    logger.info('config.provider_updated', { provider: provider.id, model: provider.defaultModel });
    return;
  }

  if (provider.requiresApiKey) {
    const maybeKey = await vscode.window.showInputBox({
      title: `Devpilot ${provider.label} API Key`,
      prompt: 'Paste API key (leave empty to keep existing secret).',
      password: true,
      ignoreFocusOut: true
    });

    if (maybeKey && maybeKey.trim()) {
      await secrets.store(getApiKeySecretName(provider.id), maybeKey.trim());
    }
  }

  const current = getDevpilotConfig();
  const apiKey = provider.requiresApiKey ? await resolveProviderApiKey(provider.id, secrets) : undefined;
  if (provider.requiresApiKey && !apiKey) {
    vscode.window.showWarningMessage('Devpilot: API key is required for this provider. Run Devpilot: Configure LLM again and enter a key.');
    return;
  }

  const client = createProviderClient(provider.id, {
    apiKey,
    openaiBaseUrl: current.openaiBaseUrl,
    anthropicBaseUrl: current.anthropicBaseUrl,
    groqBaseUrl: current.groqBaseUrl,
    openrouterBaseUrl: current.openrouterBaseUrl,
    ollamaBaseUrl: current.ollamaBaseUrl
  });

  if (!client) {
    vscode.window.showErrorMessage(`Devpilot: No provider client for ${provider.label}.`);
    return;
  }

  const models = await safelyListModels(client, provider.defaultModel, current.requestTimeoutMs);
  const modelPick = await vscode.window.showQuickPick(
    models.map((modelId) => ({
      label: modelId,
      description: modelId === provider.defaultModel ? 'default' : ''
    })),
    { placeHolder: 'Select model' }
  );

  if (!modelPick) {
    return;
  }

  await cfg.update('model', modelPick.label, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Devpilot: configured ${provider.label} with model ${modelPick.label}.`);
  logger.info('config.provider_updated', { provider: provider.id, model: modelPick.label });
}

async function runConfigureToolsCommand(logger: ReturnType<typeof createLogger>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('devpilot');
  const currentlyEnabled = new Set(
    cfg.get<string[]>(
      'enabledTools',
      ['create_directory', 'create_file', 'edit_file', 'write_file', 'replace_in_file', 'rename_file']
    )
  );

  const categories = [...new Set(CONFIGURABLE_TOOLS.map((tool) => tool.category))];
  const items: vscode.QuickPickItem[] = [];
  for (const category of categories) {
    items.push({
      label: category,
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const tool of CONFIGURABLE_TOOLS.filter((entry) => entry.category === category)) {
      items.push({
        label: tool.label,
        description: tool.description,
        detail: tool.id,
        picked: currentlyEnabled.has(tool.id)
      });
    }
  }

  const picks = await vscode.window.showQuickPick(
    items,
    {
      canPickMany: true,
      placeHolder: 'Select tools that are available to chat.'
    }
  );

  if (!picks) {
    return;
  }

  const enabledToolIds = picks
    .map((item) => item.detail ?? '')
    .filter((id) => id.length > 0);

  await cfg.update('enabledTools', enabledToolIds, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Devpilot tools updated: ${enabledToolIds.length} selected.`);
  logger.info('tools.configured', { enabledToolIds });
}

async function safelyListModels(
  client: LlmProviderClient,
  fallbackModel: string,
  timeoutMs: number
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const remote = await client.listModels(controller.signal);
    return remote.length > 0 ? remote : [fallbackModel];
  } catch {
    return [fallbackModel];
  } finally {
    clearTimeout(timer);
  }
}

async function pickAndAttachFiles(): Promise<AttachedFileContext[]> {
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: 'Attach to Devpilot'
  });

  if (!picks || picks.length === 0) {
    return [];
  }

  const attached: AttachedFileContext[] = [];
  for (const uri of picks) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      attached.push({
        path: uri.fsPath,
        name: path.basename(uri.fsPath),
        content: text.slice(0, 12000)
      });
    } catch {
      // Ignore unreadable files and continue with the rest.
    }
  }

  return attached;
}

function normalizeChatMode(value?: string): DevpilotChatMode {
  if (value === 'agent' || value === 'plan') {
    return value;
  }

  return 'chat';
}

function applyModeToPrompt(prompt: string, mode: DevpilotChatMode): string {
  if (mode === 'agent') {
    return [
      'Mode: agent',
      'Be action-oriented. Propose executable steps, commands, and implementation details grounded in workspace context.',
      'When file edits are required, append a tool envelope at the end using this exact format:',
      '<devpilot-tools>{"actions":[{"type":"write_file","path":"relative/path.ext","content":"full file content"}]}</devpilot-tools>',
      'Supported actions: create_directory, create_file, create_jupyter_notebook, edit_file, write_file, replace_in_file, rename_file.',
      'Use workspace-relative paths only and include valid JSON without markdown fences inside the envelope.',
      prompt
    ].join('\n\n');
  }

  if (mode === 'plan') {
    return [
      'Mode: plan',
      'Respond with a clear step-by-step plan first, including assumptions, risks, and validation checkpoints before deep implementation details.',
      prompt
    ].join('\n\n');
  }

  return [
    'Mode: chat',
    'Give a direct and concise assistant response tailored to the request.',
    prompt
  ].join('\n\n');
}

async function getActiveEditorAttachment(existingPaths: string[]): Promise<AttachedFileContext | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const doc = editor.document;
  if (doc.isUntitled) {
    return undefined;
  }

  const filePath = doc.fileName;
  if (existingPaths.includes(filePath)) {
    return undefined;
  }

  const text = doc.getText();
  return {
    path: filePath,
    name: path.basename(filePath),
    content: text.slice(0, 12000)
  };
}

async function maybeRunAgentTools(
  answer: string,
  allowFileWrites: boolean,
  enabledTools: string[]
): Promise<{ executedCount: number; executed: string[]; skippedReason?: string }> {
  const envelope = parseAgentToolEnvelope(answer);
  if (!envelope || envelope.actions.length === 0) {
    return { executedCount: 0, executed: [] };
  }

  const enabledSet = new Set(enabledTools);
  const actions = envelope.actions.filter((action) => enabledSet.has(normalizeAgentToolType(action.type)));
  if (actions.length === 0) {
    return {
      executedCount: 0,
      executed: [],
      skippedReason: 'requested tools are disabled in Devpilot: Configure Tools'
    };
  }

  const hasWriteAction = actions.some((action) => WRITE_TOOL_IDS.has(normalizeAgentToolType(action.type)));
  if (!allowFileWrites && hasWriteAction) {
    return {
      executedCount: 0,
      executed: [],
      skippedReason: 'agent file-write tools are disabled in Devpilot settings'
    };
  }

  const approval = await vscode.window.showWarningMessage(
    `Devpilot agent requested ${actions.length} tool action(s). Apply changes?`,
    { modal: true },
    'Apply',
    'Cancel'
  );

  if (approval !== 'Apply') {
    return {
      executedCount: 0,
      executed: [],
      skippedReason: 'user cancelled tool execution'
    };
  }

  const executed: string[] = [];
  for (const action of actions) {
    const executionLabel = await runAgentToolAction(action);
    executed.push(executionLabel);
  }

  return { executedCount: executed.length, executed };
}

function parseAgentToolEnvelope(answer: string): AgentToolEnvelope | undefined {
  const match = answer.match(/<devpilot-tools>\s*([\s\S]*?)\s*<\/devpilot-tools>/i);
  if (!match || !match[1]) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]) as AgentToolEnvelope;
    if (!parsed || !Array.isArray(parsed.actions)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

async function runAgentToolAction(action: AgentToolAction): Promise<string> {
  const toolType = normalizeAgentToolType(action.type);

  if (toolType === 'open_browser_page') {
    const url = getActionUrl(action);
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const id = `page-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const session = await createBrowserSession(id, url);
    BROWSER_SESSIONS.set(id, session);
    return `${toolType}:${id}:${url}`;
  }

  if (toolType === 'navigate_page') {
    const pageId = getActionPageId(action);
    const session = BROWSER_SESSIONS.get(pageId);
    if (!session) {
      throw new Error(`navigate_page failed: unknown pageId ${pageId}`);
    }

    const navType = getActionNavType(action);
    if (navType === 'url') {
      const nextUrl = getActionUrl(action);
      await openSessionUrl(session, nextUrl);
      const nextHistory = session.history.slice(0, session.historyIndex + 1);
      nextHistory.push(nextUrl);
      session.history = nextHistory;
      session.historyIndex = session.history.length - 1;
      session.currentUrl = nextUrl;
    }

    if (navType === 'reload') {
      await openSessionUrl(session, session.currentUrl);
    }

    if (navType === 'back' && session.historyIndex > 0) {
      session.historyIndex -= 1;
      session.currentUrl = session.history[session.historyIndex];
      await openSessionUrl(session, session.currentUrl);
    }

    if (navType === 'forward' && session.historyIndex < session.history.length - 1) {
      session.historyIndex += 1;
      session.currentUrl = session.history[session.historyIndex];
      await openSessionUrl(session, session.currentUrl);
    }

    await refreshSessionSnapshot(session);
    session.interactionLog.push(`navigate:${navType}:${session.currentUrl}`);
    BROWSER_SESSIONS.set(session.id, session);
    return `${toolType}:${session.id}:${session.currentUrl}`;
  }

  if (toolType === 'read_page') {
    const pageId = getActionPageId(action);
    const session = BROWSER_SESSIONS.get(pageId);
    if (!session) {
      throw new Error(`read_page failed: unknown pageId ${pageId}`);
    }

    await refreshSessionSnapshot(session);
    session.interactionLog.push(`read:${session.currentUrl}`);
    BROWSER_SESSIONS.set(session.id, session);
    const chars = session.lastContent?.length ?? 0;
    return `${toolType}:${session.id}:${chars}chars:url=${session.currentUrl}`;
  }

  if (toolType === 'hover_element') {
    const pageId = getActionPageId(action);
    const session = BROWSER_SESSIONS.get(pageId);
    if (!session) {
      throw new Error(`${toolType} failed: unknown pageId ${pageId}`);
    }

    const selector = getActionSelector(action);
    if (!selector) {
      return `${toolType}:${pageId}:selector-missing`;
    }

    const hasSelector = selectorExistsInHtml(selector, session.lastHtml ?? '');
    const page = getPlaywrightPage(session);
    if (page) {
      try {
        await page.hover(selector);
      } catch {
        // Keep selectorExistsInHtml result as fallback signal.
      }
    }
    session.interactionLog.push(`hover:${selector}:${hasSelector ? 'hit' : 'miss'}`);
    BROWSER_SESSIONS.set(session.id, session);
    return `${toolType}:${pageId}:${hasSelector ? 'ok' : 'selector-not-found'}:${selector}`;
  }

  if (toolType === 'type_in_page') {
    const pageId = getActionPageId(action);
    const session = BROWSER_SESSIONS.get(pageId);
    if (!session) {
      throw new Error(`${toolType} failed: unknown pageId ${pageId}`);
    }

    const selector = getActionSelector(action);
    const typed = getActionTypedInput(action);
    const hasSelector = selector ? selectorExistsInHtml(selector, session.lastHtml ?? '') : false;
    const page = getPlaywrightPage(session);
    if (page) {
      try {
        if (selector) {
          if (typed.startsWith('[key:')) {
            await page.press(selector, typed.slice(5, -1));
          } else {
            await page.fill(selector, typed);
          }
        } else if (typed.startsWith('[key:')) {
          await page.keyboard.press(typed.slice(5, -1));
        } else {
          await page.keyboard.type(typed);
        }
      } catch {
        // Fallback to log-only behavior.
      }
    }
    session.interactionLog.push(`type:${selector ?? '(focused)'}:${typed}:${hasSelector ? 'hit' : 'unknown'}`);
    BROWSER_SESSIONS.set(session.id, session);
    return `${toolType}:${pageId}:${selector ?? 'focused'}:${typed.length}chars`;
  }

  if (toolType === 'screenshot_page') {
    const pageId = getActionPageId(action);
    const session = BROWSER_SESSIONS.get(pageId);
    if (!session) {
      throw new Error(`${toolType} failed: unknown pageId ${pageId}`);
    }

    const snapshotPath = await writeBrowserSnapshotFile(session);
    const page = getPlaywrightPage(session);
    if (page) {
      const pngPath = snapshotPath.replace(/\.txt$/i, '.png');
      try {
        await page.screenshot({ path: pngPath, fullPage: true });
        session.interactionLog.push(`screenshot:${pngPath}`);
        BROWSER_SESSIONS.set(session.id, session);
        return `${toolType}:${pageId}:${pngPath}`;
      } catch {
        // Fall through to txt snapshot output.
      }
    }
    session.interactionLog.push(`screenshot:${snapshotPath}`);
    BROWSER_SESSIONS.set(session.id, session);
    return `${toolType}:${pageId}:${snapshotPath}`;
  }

  if (toolType === 'run_playwright_code') {
    const pageId = getActionPageId(action);
    const session = BROWSER_SESSIONS.get(pageId);
    if (!session) {
      throw new Error(`${toolType} failed: unknown pageId ${pageId}`);
    }

    const code = getActionCode(action);
    const page = getPlaywrightPage(session);
    if (page && code.trim().length > 0) {
      try {
        const result = await page.evaluate(code);
        session.interactionLog.push(`runCode:${code.slice(0, 120)}=>${String(result).slice(0, 120)}`);
        BROWSER_SESSIONS.set(session.id, session);
        return `${toolType}:${pageId}:ok`;
      } catch {
        // Fall through to record-only behavior.
      }
    }

    session.interactionLog.push(`runCode:${code.slice(0, 120)}`);
    BROWSER_SESSIONS.set(session.id, session);
    return `${toolType}:${pageId}:recorded`;
  }

  if (toolType === 'create_directory') {
    const dirPath = getActionPath(action);
    const dirUri = await resolveWorkspaceFileUri(dirPath);
    await vscode.workspace.fs.createDirectory(dirUri);
    return `${toolType}:${dirUri.fsPath}`;
  }

  if (toolType === 'create_jupyter_notebook') {
    const notebookPath = getActionPath(action);
    const notebookUri = await resolveWorkspaceFileUri(notebookPath);
    const parentUri = vscode.Uri.file(path.dirname(notebookUri.fsPath));
    await vscode.workspace.fs.createDirectory(parentUri);
    const content = JSON.stringify(
      {
        cells: [
          {
            cell_type: 'markdown',
            metadata: {},
            source: ['# New Notebook\\n']
          },
          {
            cell_type: 'code',
            metadata: {},
            source: [],
            execution_count: null,
            outputs: []
          }
        ],
        metadata: {
          kernelspec: {
            display_name: 'Python 3',
            language: 'python',
            name: 'python3'
          },
          language_info: {
            name: 'python'
          }
        },
        nbformat: 4,
        nbformat_minor: 5
      },
      null,
      2
    );
    await vscode.workspace.fs.writeFile(notebookUri, Buffer.from(content, 'utf-8'));
    return `${toolType}:${notebookUri.fsPath}`;
  }

  const filePath = getActionPath(action);
  const fileUri = await resolveWorkspaceFileUri(filePath);

  if (toolType === 'create_file') {
    const parentUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
    await vscode.workspace.fs.createDirectory(parentUri);

    let exists = false;
    try {
      await vscode.workspace.fs.stat(fileUri);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists) {
      throw new Error(`create_file blocked because file already exists: ${filePath}`);
    }

    const content = getActionContent(action);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
    return `${toolType}:${fileUri.fsPath}`;
  }

  if (toolType === 'write_file' || toolType === 'edit_file') {
    const parentUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
    await vscode.workspace.fs.createDirectory(parentUri);
    const content = getActionContent(action);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
    return `${toolType}:${fileUri.fsPath}`;
  }

  if (toolType === 'replace_in_file') {
    const search = getActionSearch(action);
    const replace = getActionReplace(action);
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const current = Buffer.from(bytes).toString('utf-8');
    if (!current.includes(search)) {
      throw new Error(`replace_in_file search text not found in ${filePath}`);
    }

    const next = current.replace(search, replace);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(next, 'utf-8'));
    return `${toolType}:${fileUri.fsPath}`;
  }

  if (toolType === 'rename_file') {
    const nextPath = normalizePathInput(getActionNewPath(action));
    const toUri = await resolveWorkspaceFileUri(nextPath);
    const parentUri = vscode.Uri.file(path.dirname(toUri.fsPath));
    await vscode.workspace.fs.createDirectory(parentUri);
    await vscode.workspace.fs.rename(fileUri, toUri, { overwrite: false });
    return `${toolType}:${fileUri.fsPath}=>${toUri.fsPath}`;
  }

  throw new Error('Unsupported agent tool action type');
}

function normalizeAgentToolType(type: string): string {
  if (type === 'createDirectory') {
    return 'create_directory';
  }

  if (type === 'createFile') {
    return 'create_file';
  }

  if (type === 'createJupyterNotebook') {
    return 'create_jupyter_notebook';
  }

  if (type === 'editFiles') {
    return 'edit_file';
  }

  if (type === 'rename') {
    return 'rename_file';
  }

  if (type === 'openBrowserPage') {
    return 'open_browser_page';
  }

  if (type === 'navigatePage') {
    return 'navigate_page';
  }

  if (type === 'readPage') {
    return 'read_page';
  }

  if (type === 'screenshotPage') {
    return 'screenshot_page';
  }

  if (type === 'typeInPage') {
    return 'type_in_page';
  }

  if (type === 'hoverElement') {
    return 'hover_element';
  }

  if (type === 'runPlaywrightCode') {
    return 'run_playwright_code';
  }

  return type;
}

function normalizePathInput(value: string): string {
  return value.trim();
}

async function safelyFetchPageSnapshot(url: string): Promise<{ html: string; text: string }> {
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      return { html: '', text: '' };
    }

    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);

    return {
      html: html.slice(0, 200000),
      text
    };
  } catch {
    return { html: '', text: '' };
  }
}

function selectorExistsInHtml(selector: string, html: string): boolean {
  if (!selector || !html) {
    return false;
  }

  const s = selector.trim();
  if (s.startsWith('#')) {
    const id = escapeRegExp(s.slice(1));
    return new RegExp(`id\\s*=\\s*["']${id}["']`, 'i').test(html);
  }

  if (s.startsWith('.')) {
    const className = escapeRegExp(s.slice(1));
    return new RegExp(`class\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["']`, 'i').test(html);
  }

  const tag = escapeRegExp(s.replace(/[^a-zA-Z0-9_-]/g, ''));
  return new RegExp(`<${tag}\\b`, 'i').test(html);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeBrowserSnapshotFile(session: BrowserSession): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder available for browser snapshots');
  }

  const base = folders[0].uri.fsPath;
  const snapshotDir = path.resolve(base, '.devpilot', 'browser-snapshots');
  const snapshotName = `${session.id}-${Date.now()}.txt`;
  const snapshotPath = path.resolve(snapshotDir, snapshotName);

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(snapshotDir));

  const content = [
    `Session: ${session.id}`,
    `URL: ${session.currentUrl}`,
    `History: ${session.history.join(' -> ')}`,
    '',
    'Text Preview:',
    session.lastContent ?? '',
    '',
    'Interaction Log:',
    ...session.interactionLog.slice(-20)
  ].join('\n');

  await vscode.workspace.fs.writeFile(vscode.Uri.file(snapshotPath), Buffer.from(content, 'utf-8'));
  return snapshotPath;
}

async function createBrowserSession(id: string, url: string): Promise<BrowserSession> {
  const playwright = getPlaywrightApi();
  if (!playwright) {
    const fetched = await safelyFetchPageSnapshot(url);
    return {
      id,
      currentUrl: url,
      history: [url],
      historyIndex: 0,
      lastHtml: fetched.html,
      lastContent: fetched.text,
      interactionLog: [`open:${url}`, 'runtime:snapshot'],
      runtimeMode: 'snapshot'
    };
  }

  try {
    const browser = (await playwright.chromium.launch({ headless: true })) as {
      newPage: () => Promise<{
        goto: (pageUrl: string, options?: { waitUntil?: string; timeout?: number }) => Promise<void>;
        content: () => Promise<string>;
        hover: (selector: string) => Promise<void>;
        fill: (selector: string, value: string) => Promise<void>;
        press: (selector: string, key: string) => Promise<void>;
        screenshot: (options: { path: string; fullPage?: boolean }) => Promise<void>;
        evaluate: (code: string) => Promise<unknown>;
        keyboard: { type: (text: string) => Promise<void>; press: (key: string) => Promise<void> };
      }>;
      close: () => Promise<void>;
    };
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const html = await page.content();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);

    return {
      id,
      currentUrl: url,
      history: [url],
      historyIndex: 0,
      lastHtml: html.slice(0, 200000),
      lastContent: text,
      interactionLog: [`open:${url}`, 'runtime:playwright'],
      runtimeMode: 'playwright',
      browser,
      page
    };
  } catch {
    const fetched = await safelyFetchPageSnapshot(url);
    return {
      id,
      currentUrl: url,
      history: [url],
      historyIndex: 0,
      lastHtml: fetched.html,
      lastContent: fetched.text,
      interactionLog: [`open:${url}`, 'runtime:snapshot-fallback'],
      runtimeMode: 'snapshot'
    };
  }
}

async function openSessionUrl(session: BrowserSession, url: string): Promise<void> {
  const page = getPlaywrightPage(session);
  if (page) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return;
    } catch {
      // fallback to external open
    }
  }

  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function refreshSessionSnapshot(session: BrowserSession): Promise<void> {
  const page = getPlaywrightPage(session);
  if (page) {
    try {
      const html = await page.content();
      session.lastHtml = html.slice(0, 200000);
      session.lastContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12000);
      return;
    } catch {
      // fall back to fetch snapshot
    }
  }

  const fetched = await safelyFetchPageSnapshot(session.currentUrl);
  session.lastHtml = fetched.html;
  session.lastContent = fetched.text;
}

function getPlaywrightApi(): { chromium: { launch: (options?: { headless?: boolean }) => Promise<unknown> } } | undefined {
  try {
    return require('playwright') as { chromium: { launch: (options?: { headless?: boolean }) => Promise<unknown> } };
  } catch {
    return undefined;
  }
}

function getPlaywrightPage(session: BrowserSession):
  | {
      goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<void>;
      content: () => Promise<string>;
      hover: (selector: string) => Promise<void>;
      fill: (selector: string, value: string) => Promise<void>;
      press: (selector: string, key: string) => Promise<void>;
      screenshot: (options: { path: string; fullPage?: boolean }) => Promise<void>;
      evaluate: (code: string) => Promise<unknown>;
      keyboard: { type: (text: string) => Promise<void>; press: (key: string) => Promise<void> };
    }
  | undefined {
  if (session.runtimeMode !== 'playwright') {
    return undefined;
  }

  return session.page as
    | {
        goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<void>;
        content: () => Promise<string>;
        hover: (selector: string) => Promise<void>;
        fill: (selector: string, value: string) => Promise<void>;
        press: (selector: string, key: string) => Promise<void>;
        screenshot: (options: { path: string; fullPage?: boolean }) => Promise<void>;
        evaluate: (code: string) => Promise<unknown>;
        keyboard: { type: (text: string) => Promise<void>; press: (key: string) => Promise<void> };
      }
    | undefined;
}

async function disposeAllBrowserSessions(): Promise<void> {
  for (const session of BROWSER_SESSIONS.values()) {
    const browser = session.browser as { close?: () => Promise<void> } | undefined;
    if (browser?.close) {
      try {
        await browser.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }

  BROWSER_SESSIONS.clear();
}

function getActionPageId(action: AgentToolAction): string {
  if ('pageId' in action && typeof action.pageId === 'string' && action.pageId.trim().length > 0) {
    return action.pageId.trim();
  }

  throw new Error(`Tool action ${action.type} is missing required field: pageId`);
}

function getActionSelector(action: AgentToolAction): string | undefined {
  if ('selector' in action && typeof action.selector === 'string' && action.selector.trim().length > 0) {
    return action.selector.trim();
  }

  return undefined;
}

function getActionTypedInput(action: AgentToolAction): string {
  if ('text' in action && typeof action.text === 'string' && action.text.length > 0) {
    return action.text;
  }

  if ('key' in action && typeof action.key === 'string' && action.key.length > 0) {
    return `[key:${action.key}]`;
  }

  return '';
}

function getActionCode(action: AgentToolAction): string {
  if ('code' in action && typeof action.code === 'string') {
    return action.code;
  }

  return '';
}

function getActionUrl(action: AgentToolAction): string {
  if ('url' in action && typeof action.url === 'string' && action.url.trim().length > 0) {
    return action.url.trim();
  }

  throw new Error(`Tool action ${action.type} is missing required field: url`);
}

function getActionNavType(action: AgentToolAction): 'url' | 'back' | 'forward' | 'reload' {
  if ('navType' in action && (action.navType === 'back' || action.navType === 'forward' || action.navType === 'reload' || action.navType === 'url')) {
    return action.navType;
  }

  return 'url';
}

function getActionContent(action: AgentToolAction): string {
  if ('content' in action && typeof action.content === 'string') {
    return action.content;
  }

  throw new Error(`Tool action ${action.type} is missing required field: content`);
}

function getActionPath(action: AgentToolAction): string {
  if ('path' in action && typeof action.path === 'string' && action.path.trim().length > 0) {
    return action.path.trim();
  }

  throw new Error(`Tool action ${action.type} is missing required field: path`);
}

function getActionSearch(action: AgentToolAction): string {
  if ('search' in action && typeof action.search === 'string') {
    return action.search;
  }

  throw new Error(`Tool action ${action.type} is missing required field: search`);
}

function getActionReplace(action: AgentToolAction): string {
  if ('replace' in action && typeof action.replace === 'string') {
    return action.replace;
  }

  throw new Error(`Tool action ${action.type} is missing required field: replace`);
}

function getActionNewPath(action: AgentToolAction): string {
  if ('newPath' in action && typeof action.newPath === 'string') {
    return action.newPath;
  }

  throw new Error(`Tool action ${action.type} is missing required field: newPath`);
}

async function resolveWorkspaceFileUri(requestPath: string): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder available for agent file actions');
  }

  const raw = requestPath.trim();
  if (!raw) {
    throw new Error('Agent file action path cannot be empty');
  }

  const normalized = path.normalize(raw);

  if (path.isAbsolute(normalized)) {
    for (const folder of folders) {
      if (isPathWithinFolder(normalized, folder.uri.fsPath)) {
        return vscode.Uri.file(normalized);
      }
    }

    throw new Error(`Blocked agent file action outside workspace: ${requestPath}`);
  }

  const activeEditorPath = vscode.window.activeTextEditor?.document?.isUntitled
    ? undefined
    : vscode.window.activeTextEditor?.document.fileName;

  if (activeEditorPath && path.basename(activeEditorPath).toLowerCase() === normalized.toLowerCase()) {
    return vscode.Uri.file(activeEditorPath);
  }

  const existingCandidates: string[] = [];
  for (const folder of folders) {
    const candidate = path.resolve(folder.uri.fsPath, normalized);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      existingCandidates.push(candidate);
    } catch {
      // Candidate does not exist in this folder.
    }
  }

  if (existingCandidates.length === 1) {
    return vscode.Uri.file(existingCandidates[0]);
  }

  if (existingCandidates.length > 1) {
    if (activeEditorPath && existingCandidates.includes(activeEditorPath)) {
      return vscode.Uri.file(activeEditorPath);
    }

    throw new Error(`Ambiguous agent file action path across workspace folders: ${requestPath}`);
  }

  const preferredFolder =
    folders.find((folder) => activeEditorPath && isPathWithinFolder(activeEditorPath, folder.uri.fsPath)) ?? folders[0];

  const absolute = path.resolve(preferredFolder.uri.fsPath, normalized);
  if (!isPathWithinFolder(absolute, preferredFolder.uri.fsPath)) {
    throw new Error(`Blocked agent file action outside workspace: ${requestPath}`);
  }

  return vscode.Uri.file(absolute);
}

function isPathWithinFolder(candidatePath: string, folderPath: string): boolean {
  const relative = path.relative(folderPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    || candidatePath === folderPath;
}

function enrichPromptWithAttachments(prompt: string, attachedFiles: AttachedFileContext[]): string {
  if (attachedFiles.length === 0) {
    return prompt;
  }

  const parts = attachedFiles.map((file) => {
    return [`File: ${file.path}`, '```', file.content, '```'].join('\n');
  });

  return [
    prompt,
    '',
    `Attached files (${attachedFiles.length}):`,
    ...parts
  ].join('\n');
}

function buildInlineSuggestionPayload(
  request: InlineLlmSuggestionRequest,
  enableGuardrails: boolean
): ChatRequestPayload {
  const doc = request.document;
  const position = request.position;

  const startLine = Math.max(0, position.line - 12);
  const endLine = Math.min(doc.lineCount - 1, position.line + 12);
  const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
  const surroundingContent = doc.getText(range).slice(0, 5000);
  const inlineAttachments = request.attachedFiles
    .slice(0, 1)
    .map((file) => ({ ...file, content: file.content.slice(0, 2000) }));

  const promptBase = [
    'You are completing code inline in VS Code.',
    'Return only the continuation text to insert at cursor.',
    'Do not use markdown, backticks, explanations, comments, or repeated prefix.',
    `Current line prefix: ${request.linePrefix}`,
    `Language: ${doc.languageId}`
  ].join('\n');

  const promptWithAttachments = enrichPromptWithAttachments(promptBase, inlineAttachments);
  const prompt = enableGuardrails ? sanitizePrompt(promptWithAttachments) : promptWithAttachments;

  const context: ChatContextPayload = {
    activeFile: doc.fileName,
    languageId: doc.languageId,
    cursor: `line ${position.line + 1}, col ${position.character + 1}`,
    selectionSummary: `Selection: (none)`,
    selectionRange: `start(${position.line + 1}:${position.character + 1}) end(${position.line + 1}:${position.character + 1})`,
    activeFileContent: enableGuardrails ? sanitizeContextString(surroundingContent) : surroundingContent,
    diagnosticsSummary: '(inline suggestion path) diagnostics omitted for latency',
    gitDiffSummary: '(inline suggestion path) git diff omitted for latency'
  };

  return {
    prompt,
    context
  };
}

function sanitizeContextString(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

async function openSettingsPanel(
  secrets: vscode.SecretStorage,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'devpilot.settingsPanel',
    'Devpilot Settings',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  panel.webview.html = getSettingsWebviewHtml();

  panel.webview.onDidReceiveMessage(async (message: {
    type: string;
    provider?: string;
    model?: string;
    inlineFastModelOverride?: string;
    chatMode?: string;
    autoAttachCurrentFile?: boolean;
    agentAllowFileWrites?: boolean;
    apiKeys?: Record<string, string>;
    apiKey?: string;
    inlineLlmEnabled?: boolean;
  }) => {
    if (message.type === 'load') {
      const config = getDevpilotConfig();
      const providerId = getCurrentProviderId(config.provider);
      const hasKey = await hasProviderApiKey(providerId, secrets);

      panel.webview.postMessage({
        type: 'loaded',
        provider: providerId,
        model: config.model,
        inlineFastModelOverride: config.inlineFastModelOverride,
        chatMode: config.chatMode,
        autoAttachCurrentFile: config.autoAttachCurrentFile,
        agentAllowFileWrites: config.agentAllowFileWrites,
        inlineLlmEnabled: config.inlineLlmEnabled,
        providerKeyStates: await getProviderKeyStates(secrets),
        hasKey,
        providers: listSupportedProviders()
      });
      return;
    }

    if (message.type === 'save') {
      const providerId = getCurrentProviderId(message.provider);
      const cfg = vscode.workspace.getConfiguration('devpilot');
      await cfg.update('provider', providerId, vscode.ConfigurationTarget.Global);

      const model = (message.model ?? '').trim();
      if (model.length > 0) {
        await cfg.update('model', model, vscode.ConfigurationTarget.Global);
      }

      await cfg.update('inlineFastModelOverride', (message.inlineFastModelOverride ?? '').trim(), vscode.ConfigurationTarget.Global);

      await cfg.update('chatMode', normalizeChatMode(message.chatMode), vscode.ConfigurationTarget.Global);
      await cfg.update('autoAttachCurrentFile', message.autoAttachCurrentFile === true, vscode.ConfigurationTarget.Global);
      await cfg.update('agentAllowFileWrites', message.agentAllowFileWrites === true, vscode.ConfigurationTarget.Global);

      await cfg.update('inlineLlmEnabled', message.inlineLlmEnabled === true, vscode.ConfigurationTarget.Global);

      const apiKey = (message.apiKey ?? '').trim();
      if (apiKey.length > 0) {
        await secrets.store(getApiKeySecretName(providerId), apiKey);
      }

      for (const descriptor of listSupportedProviders()) {
        if (!descriptor.requiresApiKey) {
          continue;
        }

        const raw = message.apiKeys?.[descriptor.id] ?? '';
        const nextKey = raw.trim();
        if (nextKey.length > 0) {
          await secrets.store(getApiKeySecretName(descriptor.id), nextKey);
        }
      }

      const hasKey = await hasProviderApiKey(providerId, secrets);
      panel.webview.postMessage({
        type: 'saved',
        hasKey,
        providerKeyStates: await getProviderKeyStates(secrets)
      });
      logger.info('settings.saved', { provider: providerId, hasApiKey: hasKey });
      return;
    }

    if (message.type === 'clearKey') {
      const providerId = getCurrentProviderId(message.provider);
      await secrets.delete(getApiKeySecretName(providerId));
      panel.webview.postMessage({
        type: 'saved',
        hasKey: false,
        providerKeyStates: await getProviderKeyStates(secrets)
      });
      logger.info('settings.key_cleared', { provider: providerId });
    }
  });
}

async function getProviderKeyStates(secrets: vscode.SecretStorage): Promise<Record<string, boolean>> {
  const states: Record<string, boolean> = {};
  for (const descriptor of listSupportedProviders()) {
    if (!descriptor.requiresApiKey) {
      continue;
    }

    states[descriptor.id] = await hasProviderApiKey(descriptor.id, secrets);
  }

  return states;
}

async function hasProviderApiKey(providerId: SupportedProviderId, secrets: vscode.SecretStorage): Promise<boolean> {
  if (providerId === 'local' || providerId === 'ollama') {
    return false;
  }

  const value = await resolveProviderApiKey(providerId, secrets);
  return typeof value === 'string' && value.trim().length > 0;
}

function getCurrentProviderId(value?: string): SupportedProviderId {
  const raw = (value ?? getDevpilotConfig().provider).trim().toLowerCase();
  if (isSupportedProviderId(raw)) {
    return raw;
  }

  return 'local';
}

function resolveProviderBaseUrl(config: ReturnType<typeof getDevpilotConfig>): string {
  const providerId = getCurrentProviderId(config.provider);

  if (providerId === 'openai') {
    return config.openaiBaseUrl;
  }

  if (providerId === 'anthropic') {
    return config.anthropicBaseUrl;
  }

  if (providerId === 'groq') {
    return config.groqBaseUrl;
  }

  if (providerId === 'openrouter') {
    return config.openrouterBaseUrl;
  }

  if (providerId === 'ollama') {
    return config.ollamaBaseUrl;
  }

  return config.endpoint || '(local-backend)';
}

function getApiKeySecretName(providerId: SupportedProviderId): string {
  if (providerId === 'openai') {
    return SECRET_OPENAI_API_KEY;
  }

  if (providerId === 'anthropic') {
    return SECRET_ANTHROPIC_API_KEY;
  }

  if (providerId === 'groq') {
    return SECRET_GROQ_API_KEY;
  }

  if (providerId === 'openrouter') {
    return SECRET_OPENROUTER_API_KEY;
  }

  return SECRET_API_KEY;
}

async function resolveProviderApiKey(
  providerId: SupportedProviderId,
  secrets: vscode.SecretStorage
): Promise<string | undefined> {
  const specificName = getApiKeySecretName(providerId);
  const specific = await secrets.get(specificName);
  if (specific) {
    return specific;
  }

  // Backward compatibility: migrate legacy shared key to provider-specific key.
  if (providerId === 'openai') {
    const legacy = await secrets.get(SECRET_API_KEY);
    if (legacy) {
      await secrets.store(SECRET_OPENAI_API_KEY, legacy);
      return legacy;
    }
  }

  return undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'unknown error';
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Devpilot Chat</title>
  <style>
    body {
      margin: 0;
      font-family: Segoe UI, sans-serif;
      background: #0f1420;
      color: #ecf1ff;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .topbar {
      border-bottom: 1px solid #2d3a58;
      padding: 10px 14px;
      background: linear-gradient(180deg, #172238 0%, #131c2f 100%);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .brand {
      font-weight: 700;
      letter-spacing: 0.4px;
      font-size: 13px;
    }
    .topControls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .pill {
      border: 1px solid #3b4c74;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 11px;
      color: #a9bbe8;
      background: #0f172a;
    }
    .modeSelect {
      border: 1px solid #3a4b76;
      border-radius: 999px;
      background: #0f172a;
      color: #d9e6ff;
      font-size: 11px;
      padding: 4px 8px;
    }
    .toggle {
      font-size: 11px;
      color: #a9bbe8;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid #3b4c74;
      border-radius: 999px;
      padding: 3px 8px;
      background: #0f172a;
    }
    .messages {
      flex: 1;
      overflow: auto;
      padding: 14px;
      display: grid;
      gap: 10px;
      align-content: start;
      background:
        radial-gradient(circle at 20% -10%, rgba(61, 89, 148, 0.28), transparent 35%),
        radial-gradient(circle at 80% -10%, rgba(38, 67, 122, 0.25), transparent 32%),
        #0f1420;
    }
    .msg {
      border-radius: 12px;
      padding: 10px 12px;
      border: 1px solid #2e3b5f;
      background: #17233a;
      white-space: pre-wrap;
      line-height: 1.45;
      font-size: 12px;
    }
    .msg.user {
      background: #1f2d4c;
      border-color: #3a4f7c;
    }
    .composer {
      border-top: 1px solid #2d3a58;
      padding: 10px 12px;
      background: #111a2d;
      display: grid;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 84px;
      border-radius: 8px;
      border: 1px solid #3a4b76;
      background: #0c1324;
      color: #eef3ff;
      padding: 10px;
      box-sizing: border-box;
      resize: vertical;
      font-family: Consolas, monospace;
      font-size: 12px;
    }
    .actions { display: flex; gap: 8px; }
    button {
      border: 0;
      border-radius: 8px;
      background: #2f7dff;
      color: white;
      padding: 8px 12px;
      font-weight: 600;
      cursor: pointer;
    }
    button.secondary { background: #2a3657; }
    .hint {
      color: #a7b8e2;
      font-size: 12px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brand">Devpilot Chat</div>
    <div class="topControls">
      <select id="provider" class="modeSelect" title="Provider"></select>
      <select id="mode" class="modeSelect" title="Chat mode">
        <option value="chat">Mode: Chat</option>
        <option value="agent">Mode: Agent</option>
        <option value="plan">Mode: Plan</option>
      </select>
      <label class="toggle"><input id="autoAttach" type="checkbox" /> Auto-attach current file</label>
      <div class="pill">Sidebar Ready</div>
    </div>
  </div>
  <div id="messages" class="messages">
    <div class="msg">Ask a question to start. I can use active-file context and attached files.</div>
  </div>
  <div class="composer">
    <textarea id="prompt" placeholder="Describe what to build"></textarea>
    <div class="actions">
      <button id="attach" class="secondary">Attach Files</button>
      <button id="send">Send</button>
    </div>
    <div id="attachments" class="hint">No files attached.</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById('prompt');
    const messagesEl = document.getElementById('messages');
    const sendBtn = document.getElementById('send');
    const attachBtn = document.getElementById('attach');
    const attachmentsEl = document.getElementById('attachments');
    const providerEl = document.getElementById('provider');
    const modeEl = document.getElementById('mode');
    const autoAttachEl = document.getElementById('autoAttach');

    function pushMessage(text, role = 'assistant') {
      const el = document.createElement('div');
      el.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
      el.textContent = text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function sendPrompt() {
      const text = promptEl.value || '';
      if (!text.trim()) {
        return;
      }
      pushMessage(text, 'user');
      promptEl.value = '';
      vscode.postMessage({ type: 'prompt', text });
    }

    function requestAttachFiles() {
      vscode.postMessage({ type: 'attachFiles' });
    }

    function onModeChanged() {
      vscode.postMessage({ type: 'setMode', mode: modeEl.value });
    }

    function onProviderChanged() {
      vscode.postMessage({ type: 'setProvider', provider: providerEl.value });
    }

    function onAutoAttachChanged() {
      vscode.postMessage({ type: 'setAutoAttachCurrentFile', autoAttachCurrentFile: !!autoAttachEl.checked });
    }

    sendBtn.addEventListener('click', sendPrompt);
    attachBtn.addEventListener('click', requestAttachFiles);
    providerEl.addEventListener('change', onProviderChanged);
    modeEl.addEventListener('change', onModeChanged);
    autoAttachEl.addEventListener('change', onAutoAttachChanged);
    promptEl.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        sendPrompt();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'answer') {
        pushMessage(message.text, 'assistant');
      }

      if (message.type === 'uiState') {
        const providers = Array.isArray(message.providers) ? message.providers : [];
        providerEl.innerHTML = '';
        for (const provider of providers) {
          const opt = document.createElement('option');
          opt.value = provider.id;
          opt.textContent = provider.label;
          if (provider.id === message.provider) {
            opt.selected = true;
          }
          providerEl.appendChild(opt);
        }
        modeEl.value = message.mode || 'chat';
        autoAttachEl.checked = !!message.autoAttachCurrentFile;
        const files = Array.isArray(message.files) ? message.files : [];
        attachmentsEl.textContent = files.length > 0
          ? 'Attached files: ' + files.join(', ')
          : 'No files attached.';
      }
    });
  </script>
</body>
</html>`;
}

function getSettingsWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Devpilot Settings</title>
  <style>
    body { margin: 0; font-family: Segoe UI, sans-serif; background: #121826; color: #eef3ff; }
    .wrap { max-width: 760px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
    .card { background: #1b2235; border: 1px solid #2f3b5f; border-radius: 10px; padding: 14px; }
    label { display: block; margin-bottom: 6px; font-size: 12px; color: #adc0f0; }
    select, input { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #3a4a73; background: #11172a; color: #eef3ff; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    button { border: 0; border-radius: 8px; background: #317fff; color: #fff; padding: 10px 12px; font-weight: 600; cursor: pointer; }
    button.secondary { background: #2a3350; }
    .hint { font-size: 12px; color: #adc0f0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2 style="margin-top:0;">Devpilot Settings</h2>
      <div class="hint">Store API keys once in Secret Storage and update them here whenever needed.</div>
    </div>
    <div class="card">
      <div class="row">
        <div>
          <label for="provider">Provider</label>
          <select id="provider"></select>
        </div>
        <div>
          <label for="model">Model</label>
          <input id="model" placeholder="e.g. gpt-4.1-mini" />
        </div>
      </div>
      <div style="margin-top:10px;">
        <label for="inlineFastModel">Inline Fast Model Override (optional)</label>
        <input id="inlineFastModel" placeholder="e.g. gpt-4.1-mini or claude-3-5-haiku-latest" />
      </div>
      <div style="margin-top:10px;">
        <label for="inlineMode">Inline Suggestions</label>
        <select id="inlineMode">
          <option value="on">ON</option>
          <option value="off">OFF</option>
        </select>
      </div>
      <div class="row" style="margin-top:10px;">
        <div>
          <label for="chatMode">Chat Mode</label>
          <select id="chatMode">
            <option value="chat">Chat</option>
            <option value="agent">Agent</option>
            <option value="plan">Plan</option>
          </select>
        </div>
        <div>
          <label for="autoAttachMode">Auto Attach Current File</label>
          <select id="autoAttachMode">
            <option value="on">ON</option>
            <option value="off">OFF</option>
          </select>
        </div>
      </div>
      <div style="margin-top:10px;">
        <label for="agentToolsMode">Agent File Tools</label>
        <select id="agentToolsMode">
          <option value="off">OFF</option>
          <option value="on">ON (approval required)</option>
        </select>
      </div>
      <div style="margin-top:10px;">
        <label>Provider API Keys (leave blank to keep existing)</label>
        <div class="row">
          <input id="openaiKey" type="password" placeholder="OpenAI key" />
          <input id="anthropicKey" type="password" placeholder="Anthropic key" />
        </div>
        <div class="row" style="margin-top:8px;">
          <input id="groqKey" type="password" placeholder="Groq key" />
          <input id="openrouterKey" type="password" placeholder="OpenRouter key" />
        </div>
        <div class="hint" style="margin-top:8px;">You can store multiple provider keys once, then switch provider directly from chat.</div>
      </div>
      <div id="keyStatus" class="hint" style="margin-top:10px;">Checking key state...</div>
      <div class="actions">
        <button id="save">Save</button>
        <button id="clearKey" class="secondary">Clear Saved Key</button>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const providerEl = document.getElementById('provider');
    const modelEl = document.getElementById('model');
    const inlineFastModelEl = document.getElementById('inlineFastModel');
    const inlineModeEl = document.getElementById('inlineMode');
    const chatModeEl = document.getElementById('chatMode');
    const autoAttachModeEl = document.getElementById('autoAttachMode');
    const agentToolsModeEl = document.getElementById('agentToolsMode');
    const openaiKeyEl = document.getElementById('openaiKey');
    const anthropicKeyEl = document.getElementById('anthropicKey');
    const groqKeyEl = document.getElementById('groqKey');
    const openrouterKeyEl = document.getElementById('openrouterKey');
    const keyStatusEl = document.getElementById('keyStatus');
    const saveEl = document.getElementById('save');
    const clearEl = document.getElementById('clearKey');

    function load() {
      vscode.postMessage({ type: 'load' });
    }

    function save() {
      vscode.postMessage({
        type: 'save',
        provider: providerEl.value,
        model: modelEl.value,
        inlineFastModelOverride: inlineFastModelEl.value,
        chatMode: chatModeEl.value,
        autoAttachCurrentFile: autoAttachModeEl.value === 'on',
        agentAllowFileWrites: agentToolsModeEl.value === 'on',
        inlineLlmEnabled: inlineModeEl.value === 'on',
        apiKey: '',
        apiKeys: {
          openai: openaiKeyEl.value,
          anthropic: anthropicKeyEl.value,
          groq: groqKeyEl.value,
          openrouter: openrouterKeyEl.value
        }
      });
    }

    function clearKey() {
      vscode.postMessage({ type: 'clearKey', provider: providerEl.value });
    }

    saveEl.addEventListener('click', save);
    clearEl.addEventListener('click', clearKey);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'loaded') {
        providerEl.innerHTML = '';
        for (const provider of message.providers || []) {
          const opt = document.createElement('option');
          opt.value = provider.id;
          opt.textContent = provider.label;
          if (provider.id === message.provider) {
            opt.selected = true;
          }
          providerEl.appendChild(opt);
        }
        modelEl.value = message.model || '';
        inlineFastModelEl.value = message.inlineFastModelOverride || '';
        chatModeEl.value = message.chatMode || 'chat';
        autoAttachModeEl.value = message.autoAttachCurrentFile ? 'on' : 'off';
        agentToolsModeEl.value = message.agentAllowFileWrites ? 'on' : 'off';
        inlineModeEl.value = message.inlineLlmEnabled ? 'on' : 'off';
        openaiKeyEl.value = '';
        anthropicKeyEl.value = '';
        groqKeyEl.value = '';
        openrouterKeyEl.value = '';
        const states = message.providerKeyStates || {};
        const labels = ['openai', 'anthropic', 'groq', 'openrouter']
          .filter((id) => !!states[id])
          .join(', ');
        keyStatusEl.textContent = labels
          ? 'Stored provider keys: ' + labels
          : 'No provider keys are currently stored.';
      }

      if (message.type === 'saved') {
        openaiKeyEl.value = '';
        anthropicKeyEl.value = '';
        groqKeyEl.value = '';
        openrouterKeyEl.value = '';
        const states = message.providerKeyStates || {};
        const labels = ['openai', 'anthropic', 'groq', 'openrouter']
          .filter((id) => !!states[id])
          .join(', ');
        keyStatusEl.textContent = labels
          ? 'Saved. Stored provider keys: ' + labels
          : 'Saved. No provider keys are currently stored.';
      }
    });

    load();
  </script>
</body>
</html>`;
}

export function deactivate(): void {
  // No-op.
}
