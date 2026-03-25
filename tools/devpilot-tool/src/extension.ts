import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatContextPayload, ChatRequestPayload, ChatResponsePayload, startChatBackend } from './chatBackend';
import { collectChatContext } from './contextCollector';
import { computeDiagnosticLineFixes, registerDiagnosticQuickFixProvider } from './diagnosticFixes';
import { AttachedFileContext, forceNextDiagnosticGhostForDocument, InlineLlmSuggestionRequest, registerInlineCompletionProvider } from './inlineCompletion';
import { DevpilotChatMode, getDevpilotConfig, resolveChatEndpoint, ToolApprovalScope } from './config';
import { sanitizeContext, sanitizePrompt } from './guardrails';
import { createLogger } from './logger';
import { buildQuickActionItems, toUserFriendlyError } from './commandUtils';
import { ActionPlan, buildActionPlan, buildReconReport, PlanOpportunity, ReconMode, ReconReport, renderPlanMarkdown } from './reconPlanner';
import { ALL_DEVPILOT_AGENTS, DevpilotAgentProfile } from './agentCatalog';
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
const COMMAND_RECON_AND_PLAN = 'devpilot.reconAndPlan';
const COMMAND_QUICK_ACTIONS = 'devpilot.quickActions';
const COMMAND_CONFIGURE_LLM = 'devpilot.configureLlm';
const COMMAND_OPEN_SETTINGS = 'devpilot.openSettings';
const COMMAND_CONFIGURE_TOOLS = 'devpilot.configureTools';
const COMMAND_MANAGE_AGENT_PERMISSIONS = 'devpilot.manageAgentPermissions';
const COMMAND_SHOW_TOOL_AUDIT = 'devpilot.showToolAudit';
const COMMAND_SEARCH_SUBAGENT = 'devpilot.searchSubagent';
const COMMAND_AGENT_SWARM = 'devpilot.agentSwarm';
const COMMAND_ATTACH_FILES = 'devpilot.attachFiles';
const COMMAND_TOGGLE_INLINE = 'devpilot.toggleInlineSuggestions';
const COMMAND_SHOW_FIRST_FIX_GHOST = 'devpilot.showFirstFixGhost';
const TOOL_AUDIT_PANEL_ID = 'devpilot.toolAuditPanel';
const TOOL_AUDIT_PANEL_TITLE = 'Devpilot Tool Audit Timeline';
const AGENT_PERMISSIONS_PANEL_ID = 'devpilot.agentPermissionsPanel';
const AGENT_PERMISSIONS_PANEL_TITLE = 'Devpilot Agent Permissions';
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
  | { type: 'run_playwright_code' | 'runPlaywrightCode'; pageId: string; code?: string }
  | { type: 'search_workspace' | 'searchWorkspace'; query: string; includePattern?: string; maxResults?: number };

interface AgentToolEnvelope {
  actions: AgentToolAction[];
}

interface InteractiveQuestionEnvelope {
  kind: 'yes_no' | 'single_select';
  question: string;
  options?: string[];
}

interface ConfigurableTool {
  id: string;
  category: string;
  risk: 'read' | 'edit' | 'execute' | 'browser' | 'network';
  mutating: boolean;
  label: string;
  description: string;
}

interface ToolExecutionAuditRecord {
  id?: number;
  ts: string;
  toolId: string;
  actionType: string;
  approval: 'askEveryTime' | 'allowSession' | 'allowWorkspace' | 'blocked';
  outcome: 'applied' | 'skipped' | 'failed';
  durationMs: number;
  details: string;
  error?: string;
  replayAction?: AgentToolAction;
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

interface WorkspaceSearchHit {
  path: string;
  line: number;
  preview: string;
}

interface AgentSwarmRun {
  round: number;
  agent: DevpilotAgentProfile;
  response: ChatResponsePayload;
  text: string;
  toolExecutionSummary?: string;
}

const BROWSER_SESSIONS = new Map<string, BrowserSession>();
const SESSION_ALLOWED_TOOL_IDS = new Set<string>();
const SESSION_ALLOWED_AGENT_TOOL_KEYS = new Set<string>();
const TOOL_EXECUTION_AUDIT: ToolExecutionAuditRecord[] = [];
let TOOL_AUDIT_SEQ = 0;
let TOOL_AUDIT_PANEL: vscode.WebviewPanel | undefined;
let AGENT_PERMISSIONS_PANEL: vscode.WebviewPanel | undefined;
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
  { id: 'create_directory', category: 'Built-In', risk: 'edit', mutating: true, label: 'createDirectory', description: 'Create new directories in your workspace' },
  { id: 'create_file', category: 'Built-In', risk: 'edit', mutating: true, label: 'createFile', description: 'Create new files in your workspace' },
  { id: 'create_jupyter_notebook', category: 'Built-In', risk: 'edit', mutating: true, label: 'createJupyterNotebook', description: 'Create a new Jupyter notebook file' },
  { id: 'edit_file', category: 'Built-In', risk: 'edit', mutating: true, label: 'editFiles', description: 'Edit files by replacing full file content' },
  { id: 'write_file', category: 'Built-In', risk: 'edit', mutating: true, label: 'writeFile', description: 'Write full file content in your workspace' },
  { id: 'replace_in_file', category: 'Built-In', risk: 'edit', mutating: true, label: 'editInline', description: 'Replace exact text in a file in your workspace' },
  { id: 'rename_file', category: 'Built-In', risk: 'edit', mutating: true, label: 'rename', description: 'Rename or move a file within your workspace' },
  { id: 'open_browser_page', category: 'Browser', risk: 'browser', mutating: false, label: 'openBrowserPage', description: 'Open a URL in the browser and create a page session' },
  { id: 'navigate_page', category: 'Browser', risk: 'browser', mutating: false, label: 'navigatePage', description: 'Navigate or reload a tracked page session' },
  { id: 'read_page', category: 'Browser', risk: 'read', mutating: false, label: 'readPage', description: 'Fetch readable text content for a tracked page session' },
  { id: 'screenshot_page', category: 'Browser', risk: 'browser', mutating: false, label: 'screenshotPage', description: 'Capture page screenshot (Playwright runtime when available)' },
  { id: 'type_in_page', category: 'Browser', risk: 'browser', mutating: true, label: 'typeInPage', description: 'Type text or key into a page selector/focused element' },
  { id: 'hover_element', category: 'Browser', risk: 'browser', mutating: false, label: 'hoverElement', description: 'Hover over a selector on page' },
  { id: 'run_playwright_code', category: 'Browser', risk: 'browser', mutating: true, label: 'runPlaywrightCode', description: 'Execute advanced browser code in Playwright runtime' },
  { id: 'search_workspace', category: 'Built-In', risk: 'read', mutating: false, label: 'searchWorkspace', description: 'Search workspace text and return matching snippets' }
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

          let response = await requestChatAnswer(config, payload, backendReady, context.secrets);
          const visibleSegments: string[] = [];
          let followUpCount = 0;

          while (followUpCount < 3) {
            const question = parseInteractiveQuestionEnvelope(response.answer);
            const visibleAnswer = stripInteractiveQuestionEnvelope(response.answer);
            if (visibleAnswer.length > 0) {
              visibleSegments.push(visibleAnswer);
            }

            if (!question) {
              break;
            }

            const choice = await askInteractiveQuestion(question);
            if (!choice) {
              visibleSegments.push('Interactive step cancelled by user.');
              break;
            }

            const followUpPrompt = [
              'Continue from the previous response with this confirmed user input.',
              `Question: ${question.question}`,
              `Answer: ${choice}`,
              'Do not ask the same question again. Continue with the next best concrete step.'
            ].join('\n');

            const followUpPayload: ChatRequestPayload = {
              prompt: enrichPromptWithAttachments(applyModeToPrompt(followUpPrompt, mode), finalAttachments),
              context: contextPayload
            };

            response = await requestChatAnswer(config, followUpPayload, backendReady, context.secrets);
            followUpCount += 1;
          }

          const finalAnswerText = visibleSegments.join('\n\n').trim() || response.answer;

          let toolExecutionSummary = '';
          if (mode === 'agent') {
            const execution = await maybeRunAgentTools(response.answer, config, logger);
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

          webview.postMessage({ type: 'answer', text: `${finalAnswerText}${toolExecutionSummary}` });
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

  const manageAgentPermissions = vscode.commands.registerCommand(COMMAND_MANAGE_AGENT_PERMISSIONS, async () => {
    await runManageAgentPermissionsCommand(context, logger);
  });

  const showToolAudit = vscode.commands.registerCommand(COMMAND_SHOW_TOOL_AUDIT, async () => {
    await runShowToolAuditCommand(context, output, logger);
  });

  const searchSubagent = vscode.commands.registerCommand(COMMAND_SEARCH_SUBAGENT, async () => {
    await runSearchSubagentCommand(output, logger, statusBar);
  });

  const agentSwarm = vscode.commands.registerCommand(COMMAND_AGENT_SWARM, async () => {
    await runAgentSwarmCommand(backendReady, context.secrets, output, logger, statusBar);
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

  const showFirstFixGhost = vscode.commands.registerCommand(COMMAND_SHOW_FIRST_FIX_GHOST, async () => {
    await runShowFirstFixGhostCommand(statusBar);
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

  const reconAndPlan = vscode.commands.registerCommand(COMMAND_RECON_AND_PLAN, async () => {
    await runReconAndPlanCommand(output, logger, statusBar);
  });

  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('devpilot.inlineLlmEnabled') ||
      event.affectsConfiguration('devpilot.inlineDiagnosticFixMode') ||
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

      const linePrefix = request.linePrefix;
      const nonWhitespacePrefixLength = linePrefix.replace(/\s+/g, '').length;
      if (nonWhitespacePrefixLength > 0 && nonWhitespacePrefixLength < 2) {
        return undefined;
      }

      try {
        const payload = await buildInlineSuggestionPayload(request, config);
        return await requestInlineSuggestionAnswer(config, payload, backendReady, context.secrets, token);
      } catch {
        return undefined;
      }
    },
    () => getDevpilotConfig().inlineLlmEnabled,
    () => {
      const config = getDevpilotConfig();
      return {
        debounceMs: config.inlineDebounceMs,
        llmBudgetMs: config.inlineLlmBudgetMs,
        cacheTtlMs: config.inlineCacheTtlMs,
        cacheMaxEntries: config.inlineCacheMaxEntries
      };
    },
    () => getDevpilotConfig().inlineDiagnosticFixMode
  );

  if (getDevpilotConfig().quickFixEnabled) {
    registerDiagnosticQuickFixProvider(context);
  }

  context.subscriptions.push(
    openChat,
    sidebarChatProvider,
    quickActions,
    openSettings,
    showToolAudit,
    searchSubagent,
    agentSwarm,
    configureTools,
    manageAgentPermissions,
    attachFiles,
    toggleInlineSuggestions,
    showFirstFixGhost,
    configureLlm,
    analyzeCurrentFile,
    explainSelection,
    generateTests,
    refactorSuggestion,
    reconAndPlan,
    configWatcher,
    output,
    statusBar
  );
}

async function runShowFirstFixGhostCommand(statusBar: vscode.StatusBarItem): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Devpilot: Open a file to preview fix suggestion ghost text.');
    return;
  }

  const targetLine = findFirstFixLine(editor.document);
  if (targetLine === undefined) {
    vscode.window.showInformationMessage('Devpilot: No fixable line found for ghost suggestion in this file.');
    return;
  }

  const line = editor.document.lineAt(targetLine);
  const cursor = line.range.end;
  editor.selection = new vscode.Selection(cursor, cursor);
  editor.revealRange(new vscode.Range(cursor, cursor), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  forceNextDiagnosticGhostForDocument(editor.document.uri);
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  statusBar.text = '$(sparkle) Devpilot: Fix Suggestion';
  statusBar.tooltip = 'Press Tab to accept fix ghost or Esc to dismiss.';
}

function findFirstFixLine(document: vscode.TextDocument): number | undefined {
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error || item.severity === vscode.DiagnosticSeverity.Warning)
    .sort((a, b) => a.range.start.line - b.range.start.line);

  for (const diag of diagnostics) {
    const line = diag.range.start.line;
    if (computeDiagnosticLineFixes(document, line).length > 0) {
      return line;
    }
  }

  // Fallback for files with no diagnostics: only consider explicit structural fixes, not indentation hints.
  for (let line = 0; line < document.lineCount; line += 1) {
    const hasStructuralFix = computeDiagnosticLineFixes(document, line)
      .some((fix) => fix.title.includes('Fix merged keywords'));
    if (hasStructuralFix) {
      return line;
    }
  }

  return undefined;
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

async function runShowToolAuditCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  if (TOOL_AUDIT_PANEL) {
    TOOL_AUDIT_PANEL.reveal(vscode.ViewColumn.Beside, true);
    publishToolAuditState(TOOL_AUDIT_PANEL.webview);
    return;
  }

  TOOL_AUDIT_PANEL = vscode.window.createWebviewPanel(
    TOOL_AUDIT_PANEL_ID,
    TOOL_AUDIT_PANEL_TITLE,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  TOOL_AUDIT_PANEL.webview.html = getToolAuditWebviewHtml();

  TOOL_AUDIT_PANEL.onDidDispose(() => {
    TOOL_AUDIT_PANEL = undefined;
  }, undefined, context.subscriptions);

  TOOL_AUDIT_PANEL.webview.onDidReceiveMessage(async (message: { type?: string; id?: number }) => {
    if (!message?.type) {
      return;
    }

    if (message.type === 'ready' || message.type === 'refresh') {
      publishToolAuditState(TOOL_AUDIT_PANEL?.webview);
      return;
    }

    if (message.type === 'export') {
      try {
        const exportedPath = await exportToolAuditJson();
        logger.info('tools.audit_exported', { path: exportedPath, records: TOOL_EXECUTION_AUDIT.length });
        vscode.window.showInformationMessage(`Devpilot tool audit exported: ${exportedPath}`);
        publishToolAuditState(TOOL_AUDIT_PANEL?.webview, `Exported JSON to ${exportedPath}`);
      } catch (error) {
        publishToolAuditState(TOOL_AUDIT_PANEL?.webview, `Export failed: ${toErrorMessage(error)}`);
      }
      return;
    }

    if (message.type === 'clear') {
      TOOL_EXECUTION_AUDIT.splice(0, TOOL_EXECUTION_AUDIT.length);
      output.clear();
      output.appendLine('=== Devpilot Tool Audit Timeline ===');
      output.appendLine('Audit records cleared by user action.');
      output.show(true);
      logger.info('tools.audit_cleared', {});
      publishToolAuditState(TOOL_AUDIT_PANEL?.webview, 'Audit records cleared.');
      return;
    }

    if (message.type === 'copyAction') {
      const record = findToolAuditRecordById(message.id);
      if (!record?.replayAction) {
        publishToolAuditState(TOOL_AUDIT_PANEL?.webview, 'No replay action payload available for this record.');
        return;
      }

      await vscode.env.clipboard.writeText(JSON.stringify(record.replayAction, null, 2));
      publishToolAuditState(TOOL_AUDIT_PANEL?.webview, 'Copied replay action JSON to clipboard.');
      return;
    }

    if (message.type === 'rerunAction') {
      const record = findToolAuditRecordById(message.id);
      if (!record?.replayAction) {
        publishToolAuditState(TOOL_AUDIT_PANEL?.webview, 'No replay action payload available for this record.');
        return;
      }

      const toolId = normalizeAgentToolType(record.replayAction.type);
      if (!isReplaySafeToolId(toolId)) {
        publishToolAuditState(TOOL_AUDIT_PANEL?.webview, `Replay blocked for mutating tool: ${toolId}`);
        return;
      }

      const startedAt = Date.now();
      const details = `[rerun] ${summarizeActionDetails(record.replayAction)}`;
      const cfg = getDevpilotConfig();

      try {
        const executionLabel = await runAgentToolAction(record.replayAction);
        appendToolAudit(
          {
            ts: new Date().toISOString(),
            toolId,
            actionType: record.replayAction.type,
            approval: 'askEveryTime',
            outcome: 'applied',
            durationMs: Date.now() - startedAt,
            details: `${details} => ${executionLabel}`,
            replayAction: record.replayAction
          },
          cfg.toolAuditMaxEntries,
          logger
        );
        publishToolAuditState(TOOL_AUDIT_PANEL?.webview, `Reran ${toolId} successfully.`);
      } catch (error) {
        appendToolAudit(
          {
            ts: new Date().toISOString(),
            toolId,
            actionType: record.replayAction.type,
            approval: 'askEveryTime',
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
            details,
            error: toErrorMessage(error),
            replayAction: record.replayAction
          },
          cfg.toolAuditMaxEntries,
          logger
        );
        publishToolAuditState(TOOL_AUDIT_PANEL?.webview, `Rerun failed: ${toErrorMessage(error)}`);
      }
    }
  }, undefined, context.subscriptions);

  publishToolAuditState(TOOL_AUDIT_PANEL.webview);
}

function publishToolAuditState(webview: vscode.Webview | undefined, toast?: string): void {
  if (!webview) {
    return;
  }

  const last50 = TOOL_EXECUTION_AUDIT.slice(-50).map((entry) => ({
    ...entry,
    canReplay: Boolean(entry.replayAction) && isReplaySafeToolId(entry.toolId),
    hasReplayAction: Boolean(entry.replayAction)
  }));
  const summary = {
    total: TOOL_EXECUTION_AUDIT.length,
    applied: TOOL_EXECUTION_AUDIT.filter((entry) => entry.outcome === 'applied').length,
    failed: TOOL_EXECUTION_AUDIT.filter((entry) => entry.outcome === 'failed').length,
    skipped: TOOL_EXECUTION_AUDIT.filter((entry) => entry.outcome === 'skipped').length
  };

  webview.postMessage({
    type: 'auditState',
    entries: last50,
    summary,
    toast
  });
}

function findToolAuditRecordById(id: number | undefined): ToolExecutionAuditRecord | undefined {
  if (!Number.isFinite(id)) {
    return undefined;
  }

  return TOOL_EXECUTION_AUDIT.find((entry) => entry.id === id);
}

function isReplaySafeToolId(toolId: string): boolean {
  const configured = CONFIGURABLE_TOOLS.find((entry) => entry.id === toolId);
  return Boolean(configured && !configured.mutating);
}

async function exportToolAuditJson(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder available for exporting tool audit.');
  }

  const baseDir = path.resolve(folders[0].uri.fsPath, '.devpilot', 'tool-audit');
  const fileName = `tool-audit-${Date.now()}.json`;
  const targetPath = path.resolve(baseDir, fileName);

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(baseDir));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(targetPath),
    Buffer.from(JSON.stringify(TOOL_EXECUTION_AUDIT, null, 2), 'utf-8')
  );

  return targetPath;
}

async function runSearchSubagentCommand(
  output: vscode.OutputChannel,
  logger: ReturnType<typeof createLogger>,
  statusBar: vscode.StatusBarItem
): Promise<void> {
  const query = (await vscode.window.showInputBox({
    prompt: 'Search Subagent query',
    placeHolder: 'Example: tool approval defaultReadScope',
    validateInput: (value) => (value.trim().length === 0 ? 'Query is required.' : undefined)
  }))?.trim();

  if (!query) {
    return;
  }

  const scopeChoice = await vscode.window.showQuickPick(
    [
      { label: 'All workspace files', value: 'all' as const },
      { label: 'Active file only', value: 'active' as const },
      { label: 'Custom glob pattern', value: 'custom' as const }
    ],
    { placeHolder: 'Choose search scope' }
  );

  if (!scopeChoice) {
    return;
  }

  let includePattern: string | undefined;
  if (scopeChoice.value === 'active') {
    const activePath = vscode.window.activeTextEditor?.document?.fileName;
    if (!activePath) {
      vscode.window.showWarningMessage('Devpilot: no active editor. Falling back to all workspace files.');
    } else {
      includePattern = vscode.workspace.asRelativePath(activePath, false).replace(/\\/g, '/');
    }
  }

  if (scopeChoice.value === 'custom') {
    includePattern = normalizeIncludePattern(
      await vscode.window.showInputBox({
        prompt: 'Enter include glob pattern (workspace-relative)',
        placeHolder: 'Example: src/** or **/*.ts',
        validateInput: (value) => (value.trim().length === 0 ? 'Glob pattern is required.' : undefined)
      })
    );

    if (!includePattern) {
      return;
    }
  }

  const maxResultsPick = await vscode.window.showQuickPick(
    [
      { label: '10 results', value: '10' },
      { label: '25 results', value: '25' },
      { label: '50 results', value: '50' }
    ],
    { placeHolder: 'Max results' }
  );

  if (!maxResultsPick) {
    return;
  }

  const maxResults = Number.parseInt(maxResultsPick.value, 10);
  setStatusBar(statusBar, 'working');

  try {
    const hits = await searchWorkspaceSnippets(query, includePattern, maxResults);
    output.clear();
    output.appendLine('=== Devpilot Search Subagent ===');
    output.appendLine(`query: ${query}`);
    output.appendLine(`include: ${includePattern ?? '(all files)'}`);
    output.appendLine(`hits: ${hits.length}`);
    output.appendLine('');

    if (hits.length === 0) {
      output.appendLine('No matches found.');
    } else {
      for (const hit of hits) {
        output.appendLine(`${hit.path}:${hit.line} | ${hit.preview}`);
      }
    }

    output.show(true);
    logger.info('subagent.search.completed', { query, includePattern: includePattern ?? '(all)', maxResults, hits: hits.length });
    setStatusBar(statusBar, 'ready');
    vscode.window.showInformationMessage(`Devpilot Search Subagent: found ${hits.length} match(es).`);
  } catch (error) {
    const messageText = toErrorMessage(error);
    logger.error('subagent.search.failed', { query, includePattern: includePattern ?? '(all)', reason: messageText });
    output.appendLine(`[devpilot] Search Subagent failed: ${messageText}`);
    output.show(true);
    setStatusBar(statusBar, 'error');
    vscode.window.showErrorMessage(`Devpilot Search Subagent failed: ${messageText}`);
  }
}

function parseInteractiveQuestionEnvelope(answer: string): InteractiveQuestionEnvelope | undefined {
  const match = answer.match(/<devpilot-question>\s*([\s\S]*?)\s*<\/devpilot-question>/i);
  if (!match || !match[1]) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]) as InteractiveQuestionEnvelope;
    if (!parsed || typeof parsed.question !== 'string') {
      return undefined;
    }

    if (parsed.kind !== 'yes_no' && parsed.kind !== 'single_select') {
      return undefined;
    }

    if (parsed.kind === 'single_select') {
      if (!Array.isArray(parsed.options) || parsed.options.length < 2) {
        return undefined;
      }
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function stripInteractiveQuestionEnvelope(answer: string): string {
  return answer.replace(/\s*<devpilot-question>[\s\S]*?<\/devpilot-question>\s*/gi, '').trim();
}

async function askInteractiveQuestion(question: InteractiveQuestionEnvelope): Promise<string | undefined> {
  if (question.kind === 'yes_no') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' }
      ],
      {
        placeHolder: question.question,
        ignoreFocusOut: true
      }
    );

    return pick?.value;
  }

  const picks = (question.options ?? []).map((item) => ({
    label: item,
    value: item
  }));

  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: question.question,
    ignoreFocusOut: true
  });
  return pick?.value;
}

async function runAgentSwarmCommand(
  backendReady: Promise<Awaited<ReturnType<typeof startChatBackend>>>,
  secrets: vscode.SecretStorage,
  output: vscode.OutputChannel,
  logger: ReturnType<typeof createLogger>,
  statusBar: vscode.StatusBarItem
): Promise<void> {
  const selectedAgents = await vscode.window.showQuickPick(
    ALL_DEVPILOT_AGENTS.map((agent) => ({
      label: agent.id,
      description: `${agent.group} - ${agent.title}`,
      detail: agent.purpose,
      agent
    })),
    {
      canPickMany: true,
      placeHolder: 'Select one or more specialist agents'
    }
  );

  if (!selectedAgents || selectedAgents.length === 0) {
    return;
  }

  const roundsPick = await vscode.window.showQuickPick(
    [
      { label: '1 Round (independent specialist pass)', value: 1 },
      { label: '2 Rounds (review and refine)', value: 2 },
      { label: '3 Rounds (deeper collaboration)', value: 3 }
    ],
    { placeHolder: 'Choose collaboration rounds' }
  );

  if (!roundsPick) {
    return;
  }

  const toolExecutionPick = await vscode.window.showQuickPick(
    [
      { label: 'No tool execution (analysis only)', value: 'off' as const },
      { label: 'Allow tool execution per agent approval', value: 'on' as const }
    ],
    { placeHolder: 'Should specialist agents be allowed to execute tools?' }
  );

  if (!toolExecutionPick) {
    return;
  }

  const task = (await vscode.window.showInputBox({
    prompt: 'Describe the outcome you want from the selected agents',
    placeHolder: 'Example: Improve model-evaluation experiment design and rollout plan',
    validateInput: (value) => (value.trim().length === 0 ? 'Task is required.' : undefined)
  }))?.trim();

  if (!task) {
    return;
  }

  setStatusBar(statusBar, 'working');
  try {
    const config = getDevpilotConfig();
    const contextRaw = await collectChatContext();
    const contextPayload = config.enableGuardrails ? sanitizeContext(contextRaw) : contextRaw;
    const runs: AgentSwarmRun[] = [];
    const latestByAgent = new Map<string, string>();
    const totalRounds = roundsPick.value;
    const allowToolExecution = toolExecutionPick.value === 'on';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Devpilot Agent Swarm (${selectedAgents.length} agents x ${totalRounds} rounds)`,
        cancellable: false
      },
      async (progress) => {
        const totalSteps = selectedAgents.length * totalRounds;
        const perStepIncrement = Math.max(2, Math.floor(75 / Math.max(1, totalSteps)));

        for (let round = 1; round <= totalRounds; round += 1) {
          for (const pick of selectedAgents) {
            const agent = pick.agent;
            progress.report({ message: `Round ${round}/${totalRounds}: ${agent.id}`, increment: perStepIncrement });

            const peerContext = [...latestByAgent.entries()]
              .filter(([agentId]) => agentId !== agent.id)
              .map(([agentId, text]) => `${agentId}: ${text.slice(0, 1200)}`)
              .join('\n\n');

            const specialistPrompt = [
              `You are specialist agent: ${agent.id}`,
              `Group: ${agent.group}`,
              `Purpose: ${agent.purpose}`,
              `Responsibilities: ${agent.responsibilities.join('; ')}`,
              `Task: ${task}`,
              `Collaboration round: ${round} of ${totalRounds}`,
              round > 1
                ? 'Use peer insights from previous rounds to refine or challenge your proposal.'
                : 'Provide your initial specialist recommendation.',
              peerContext.length > 0 ? `Peer insights:\n${peerContext}` : 'Peer insights: (none yet)',
              'Return concise, concrete recommendations only for this specialist role.'
            ].join('\n');

            const response = await requestChatAnswer(
              config,
              {
                prompt: applyModeToPrompt(specialistPrompt, allowToolExecution ? 'agent' : 'plan'),
                context: contextPayload
              },
              backendReady,
              secrets
            );

            const text = stripInteractiveQuestionEnvelope(response.answer);
            latestByAgent.set(agent.id, text);

            let toolExecutionSummary: string | undefined;
            if (allowToolExecution) {
              const execution = await maybeRunAgentTools(response.answer, config, logger, agent.id);
              if (execution.executedCount > 0 || execution.skippedReason) {
                toolExecutionSummary = execution.executedCount > 0
                  ? `Applied ${execution.executedCount} action(s): ${execution.executed.join(', ')}`
                  : `No actions applied: ${execution.skippedReason ?? 'not requested'}`;
              }
            }

            runs.push({ round, agent, response, text, toolExecutionSummary });
          }
        }

        progress.report({ message: 'Synthesizing final recommendation...', increment: 25 });
      }
    );

    const finalRoundByAgent = selectedAgents
      .map((pick) => {
        const matching = [...runs]
          .filter((run) => run.agent.id === pick.agent.id)
          .sort((a, b) => b.round - a.round)[0];
        return matching;
      })
      .filter((item): item is AgentSwarmRun => Boolean(item));

    const synthesisPrompt = [
      `Task: ${task}`,
      `Collaboration rounds completed: ${totalRounds}`,
      'Combine the specialist outputs below into one practical execution plan.',
      'Keep conflicting recommendations explicit and provide final priority order.',
      '',
      ...finalRoundByAgent.map(
        (run, index) =>
          `Specialist ${index + 1} (${run.agent.id}, round ${run.round}):\n${run.text}`
      )
    ].join('\n\n');

    const synthesis = await requestChatAnswer(
      config,
      {
        prompt: applyModeToPrompt(synthesisPrompt, 'plan'),
        context: contextPayload
      },
      backendReady,
      secrets
    );

    output.clear();
    output.appendLine('=== Devpilot Agent Swarm ===');
    output.appendLine(`task: ${task}`);
    output.appendLine(`agents: ${selectedAgents.map((run) => run.agent.id).join(', ')}`);
    output.appendLine(`rounds: ${totalRounds}`);
    output.appendLine(`tool execution: ${allowToolExecution ? 'enabled (per-agent approvals)' : 'disabled'}`);
    output.appendLine('');
    for (const run of runs) {
      output.appendLine(`--- Round ${run.round}: ${run.agent.id} (${run.agent.group}) ---`);
      output.appendLine(run.text);
      if (run.toolExecutionSummary) {
        output.appendLine(`Tool execution: ${run.toolExecutionSummary}`);
      }
      output.appendLine('');
    }
    output.appendLine('=== Synthesized Plan ===');
    output.appendLine(stripInteractiveQuestionEnvelope(synthesis.answer));
    output.show(true);

    logger.info('subagent.swarm.completed', {
      task,
      agents: selectedAgents.map((run) => run.agent.id),
      rounds: totalRounds,
      toolExecution: allowToolExecution,
      count: runs.length,
      provider: getCurrentProviderId(config.provider)
    });
    setStatusBar(statusBar, 'ready');
    vscode.window.showInformationMessage(`Devpilot Agent Swarm complete with ${runs.length} specialist outputs across ${totalRounds} rounds.`);
  } catch (error) {
    const messageText = toErrorMessage(error);
    logger.error('subagent.swarm.failed', { reason: messageText });
    output.appendLine(`[devpilot] Agent Swarm failed: ${messageText}`);
    output.show(true);
    setStatusBar(statusBar, 'error');
    vscode.window.showErrorMessage(`Devpilot Agent Swarm failed: ${messageText}`);
  }
}

async function runReconAndPlanCommand(
  output: vscode.OutputChannel,
  logger: ReturnType<typeof createLogger>,
  statusBar: vscode.StatusBarItem
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Devpilot Recon and Plan requires an open workspace folder.');
    return;
  }

  const modePick = await vscode.window.showQuickPick(
    [
      { label: 'Quick Recon', value: 'quick' as ReconMode, description: 'Fast top-level signal scan' },
      { label: 'Deep Recon', value: 'deep' as ReconMode, description: 'Broader scan with additional checks' }
    ],
    { placeHolder: 'Choose recon depth' }
  );

  if (!modePick) {
    return;
  }

  const root = folders[0].uri;
  setStatusBar(statusBar, 'working');

  try {
    const artifacts = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Devpilot Recon and Plan (${modePick.value})`,
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Scanning workspace signals...', increment: 20 });
        const report = await buildReconReport(root, modePick.value);

        progress.report({ message: 'Ranking opportunities...', increment: 35 });
        const plan = buildActionPlan(report);

        progress.report({ message: 'Writing artifacts...', increment: 35 });
        const paths = await writeReconArtifacts(root, report, plan);
        const markdown = renderPlanMarkdown(report, plan);

        progress.report({ message: 'Done', increment: 10 });
        return { report, plan, markdown, paths };
      }
    );

    output.clear();
    output.appendLine('=== Devpilot Recon and Plan ===');
    output.appendLine(`mode: ${modePick.value}`);
    output.appendLine(`workspace: ${root.fsPath}`);
    output.appendLine(`toolchain: ${artifacts.report.detectedToolchain.join(', ') || '(none detected)'}`);
    output.appendLine(`signals: ${artifacts.report.signals.length}`);
    output.appendLine(`opportunities: ${artifacts.plan.opportunities.length}`);
    output.appendLine(`recon-report: ${artifacts.paths.reconReportPath}`);
    output.appendLine(`action-plan: ${artifacts.paths.actionPlanPath}`);
    output.appendLine(`plan-md: ${artifacts.paths.planMarkdownPath}`);
    output.appendLine('');
    if (artifacts.plan.opportunities.length > 0) {
      output.appendLine('Top opportunities:');
      artifacts.plan.opportunities.slice(0, 5).forEach((opp, index) => {
        output.appendLine(`${index + 1}. [${opp.score.toFixed(2)}] ${opp.title} (risk=${opp.risk}, eta=${opp.etaMinutes}m)`);
      });
    } else {
      output.appendLine('No opportunities detected in this run.');
    }
    output.show(true);

    logger.info('recon.plan.completed', {
      mode: modePick.value,
      signals: artifacts.report.signals.length,
      opportunities: artifacts.plan.opportunities.length,
      reconReportPath: artifacts.paths.reconReportPath,
      actionPlanPath: artifacts.paths.actionPlanPath,
      planMarkdownPath: artifacts.paths.planMarkdownPath
    });

    const postAction = await vscode.window.showQuickPick(
      [
        { label: 'Show Full Plan', value: 'showPlan' as const },
        { label: 'Open generated PLAN.md', value: 'openPlan' as const },
        { label: 'Apply safe autofixes (Phase 2)', value: 'phase2' as const }
      ],
      { placeHolder: 'Recon complete. Choose next step.' }
    );

    if (postAction?.value === 'showPlan') {
      output.appendLine('');
      output.appendLine('--- PLAN.md Preview ---');
      output.appendLine(artifacts.markdown);
      output.show(true);
    }

    if (postAction?.value === 'openPlan') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(artifacts.paths.planMarkdownPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    if (postAction?.value === 'phase2') {
      await runReconPhase2Autofix(root, artifacts.plan, output, logger);
    }

    setStatusBar(statusBar, 'ready');
    vscode.window.showInformationMessage(`Devpilot Recon complete: ${artifacts.plan.opportunities.length} opportunities found.`);
  } catch (error) {
    const messageText = toErrorMessage(error);
    logger.error('recon.plan.failed', { reason: messageText });
    output.appendLine(`[devpilot] Recon and Plan failed: ${messageText}`);
    output.show(true);
    setStatusBar(statusBar, 'error');
    vscode.window.showErrorMessage(`Devpilot Recon and Plan failed: ${messageText}`);
  }
}

async function writeReconArtifacts(
  root: vscode.Uri,
  report: ReconReport,
  plan: ActionPlan
): Promise<{ reconReportPath: string; actionPlanPath: string; planMarkdownPath: string }> {
  const baseDir = path.resolve(root.fsPath, '.devpilot');
  const reconReportPath = path.resolve(baseDir, 'recon-report.json');
  const actionPlanPath = path.resolve(baseDir, 'action-plan.json');
  const planMarkdownPath = path.resolve(baseDir, 'PLAN.md');

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(baseDir));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(reconReportPath),
    Buffer.from(JSON.stringify(report, null, 2), 'utf-8')
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(actionPlanPath),
    Buffer.from(JSON.stringify(plan, null, 2), 'utf-8')
  );

  const markdown = renderPlanMarkdown(report, plan);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(planMarkdownPath),
    Buffer.from(markdown, 'utf-8')
  );

  return { reconReportPath, actionPlanPath, planMarkdownPath };
}

async function runReconPhase2Autofix(
  root: vscode.Uri,
  plan: ActionPlan,
  output: vscode.OutputChannel,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const safeOpportunities = plan.opportunities.filter((opportunity) => opportunity.autofixAvailable && isOpportunitySafeAutofix(opportunity));

  if (safeOpportunities.length === 0) {
    vscode.window.showInformationMessage('No safe autofixes are available in this plan.');
    return;
  }

  const phase2Pick = await vscode.window.showQuickPick(
    [
      { label: 'Preview a safe autofix', value: 'preview' as const },
      { label: 'Apply one safe autofix', value: 'applyOne' as const },
      { label: 'Apply all safe autofixes (with checkpoint)', value: 'applyAll' as const },
      { label: 'Rollback latest safe autofix batch', value: 'rollback' as const }
    ],
    { placeHolder: 'Choose Phase 2 autofix action' }
  );

  if (!phase2Pick) {
    return;
  }

  if (phase2Pick.value === 'rollback') {
    const rollback = await rollbackLatestPhase3Checkpoint(root);
    if (!rollback) {
      vscode.window.showInformationMessage('No Phase 3 checkpoint found to rollback.');
      return;
    }

    output.appendLine('');
    output.appendLine('--- Phase 3 Rollback ---');
    output.appendLine(`checkpoint: ${rollback.checkpointId}`);
    output.appendLine(`restored: ${rollback.restored}`);
    output.appendLine(`deleted: ${rollback.deleted}`);
    output.appendLine(`missing: ${rollback.missing}`);
    output.show(true);

    logger.info('recon.plan.phase3.rollback', {
      checkpointId: rollback.checkpointId,
      restored: rollback.restored,
      deleted: rollback.deleted,
      missing: rollback.missing
    });

    vscode.window.showInformationMessage(`Rolled back checkpoint ${rollback.checkpointId}.`);
    return;
  }

  if (phase2Pick.value === 'applyAll') {
    const batch = await applySafeAutofixBatchWithCheckpoint(root, safeOpportunities);
    const summaries = batch.summaries;

    output.appendLine('');
    output.appendLine('--- Phase 3 Autofix Batch ---');
    output.appendLine(`checkpoint: ${batch.checkpointId}`);
    summaries.forEach((line) => output.appendLine(line));
    output.show(true);

    logger.info('recon.plan.phase3.batchApplied', {
      opportunities: safeOpportunities.length,
      summary: summaries,
      checkpointId: batch.checkpointId,
      appliedFiles: batch.appliedFiles,
      skippedFiles: batch.skippedFiles
    });

    const rollbackChoice = await vscode.window.showQuickPick(
      [
        { label: 'Keep batch changes', value: 'keep' as const },
        { label: 'Rollback this batch now', value: 'rollback' as const }
      ],
      { placeHolder: 'Phase 3 batch complete. Keep or rollback?' }
    );

    if (rollbackChoice?.value === 'rollback') {
      const rollback = await rollbackPhase3Checkpoint(root, batch.checkpoint);
      output.appendLine('');
      output.appendLine('--- Phase 3 Immediate Rollback ---');
      output.appendLine(`checkpoint: ${rollback.checkpointId}`);
      output.appendLine(`restored: ${rollback.restored}`);
      output.appendLine(`deleted: ${rollback.deleted}`);
      output.appendLine(`missing: ${rollback.missing}`);
      output.show(true);

      logger.info('recon.plan.phase3.immediateRollback', {
        checkpointId: rollback.checkpointId,
        restored: rollback.restored,
        deleted: rollback.deleted,
        missing: rollback.missing
      });

      vscode.window.showInformationMessage('Rolled back safe autofix batch.');
      return;
    }

    vscode.window.showInformationMessage(`Applied safe autofixes for ${safeOpportunities.length} opportunity(ies) with checkpoint ${batch.checkpointId}.`);
    return;
  }

  const target = await pickSafeOpportunity(safeOpportunities, phase2Pick.value === 'preview' ? 'Preview safe autofix' : 'Apply safe autofix');
  if (!target) {
    return;
  }

  if (phase2Pick.value === 'preview') {
    const preview = await buildOpportunityAutofixPreview(root, target);
    output.appendLine('');
    output.appendLine(`--- Phase 2 Autofix Preview: ${target.title} ---`);
    output.appendLine(preview);
    output.show(true);

    logger.info('recon.plan.phase2.preview', { opportunityId: target.id });
    return;
  }

  const result = await applyOpportunityAutofix(root, target);
  output.appendLine('');
  output.appendLine(`--- Phase 2 Autofix Apply: ${target.title} ---`);
  output.appendLine(`Applied files: ${result.applied}`);
  if (result.skipped.length > 0) {
    output.appendLine('Skipped:');
    result.skipped.forEach((reason) => output.appendLine(`- ${reason}`));
  }
  output.show(true);

  logger.info('recon.plan.phase2.applied', {
    opportunityId: target.id,
    appliedFiles: result.applied,
    skipped: result.skipped
  });

  vscode.window.showInformationMessage(`Applied safe autofix for ${target.title}.`);
}

function isOpportunitySafeAutofix(opportunity: PlanOpportunity): boolean {
  if (!opportunity.autofixAvailable || !Array.isArray(opportunity.autofixEdits) || opportunity.autofixEdits.length === 0) {
    return false;
  }

  return opportunity.actions.every((action) => action.safe);
}

async function pickSafeOpportunity(opportunities: PlanOpportunity[], placeHolder: string): Promise<PlanOpportunity | undefined> {
  const selected = await vscode.window.showQuickPick(
    opportunities.map((opportunity) => ({
      label: opportunity.title,
      value: opportunity.id,
      description: `score=${opportunity.score.toFixed(2)} risk=${opportunity.risk}`
    })),
    { placeHolder }
  );

  if (!selected) {
    return undefined;
  }

  return opportunities.find((opportunity) => opportunity.id === selected.value);
}

async function buildOpportunityAutofixPreview(root: vscode.Uri, opportunity: PlanOpportunity): Promise<string> {
  const edits = opportunity.autofixEdits ?? [];
  const lines: string[] = [];

  lines.push(`Opportunity: ${opportunity.title}`);
  lines.push(`ID: ${opportunity.id}`);
  lines.push(`Edits: ${edits.length}`);
  lines.push('');

  for (const edit of edits) {
    const targetUri = vscode.Uri.joinPath(root, ...edit.path.split('/'));
    const relativeTarget = path.relative(root.fsPath, targetUri.fsPath).replace(/\\/g, '/');
    const exists = await pathExists(targetUri);

    lines.push(`File: ${relativeTarget}`);
    lines.push(`Operation: ${exists ? 'skip (already exists)' : 'create'}`);
    lines.push('--- Begin Content ---');
    lines.push(edit.content);
    lines.push('--- End Content ---');
    lines.push('');
  }

  return lines.join('\n');
}

async function applyOpportunityAutofix(
  root: vscode.Uri,
  opportunity: PlanOpportunity
): Promise<{ applied: number; skipped: string[]; appliedPaths: string[] }> {
  const edits = opportunity.autofixEdits ?? [];
  let applied = 0;
  const skipped: string[] = [];
  const appliedPaths: string[] = [];

  for (const edit of edits) {
    const targetUri = vscode.Uri.joinPath(root, ...edit.path.split('/'));
    const relativeTarget = path.relative(root.fsPath, targetUri.fsPath).replace(/\\/g, '/');

    if (await pathExists(targetUri)) {
      skipped.push(`${relativeTarget} already exists`);
      continue;
    }

    const parentDir = path.dirname(targetUri.fsPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentDir));
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(edit.content, 'utf-8'));
    applied += 1;
    appliedPaths.push(relativeTarget);
  }

  return { applied, skipped, appliedPaths };
}

interface Phase3CheckpointEntry {
  path: string;
  existed: boolean;
  previousContentBase64?: string;
}

interface Phase3Checkpoint {
  id: string;
  createdAt: string;
  workspaceRoot: string;
  entries: Phase3CheckpointEntry[];
}

async function applySafeAutofixBatchWithCheckpoint(
  root: vscode.Uri,
  safeOpportunities: PlanOpportunity[]
): Promise<{ checkpointId: string; summaries: string[]; appliedFiles: number; skippedFiles: number; checkpoint: Phase3Checkpoint }> {
  const checkpointId = buildPhase3CheckpointId();
  const checkpointMap = new Map<string, Phase3CheckpointEntry>();

  for (const opportunity of safeOpportunities) {
    for (const edit of opportunity.autofixEdits ?? []) {
      const key = edit.path.replace(/\\/g, '/');
      if (checkpointMap.has(key)) {
        continue;
      }

      const targetUri = vscode.Uri.joinPath(root, ...edit.path.split('/'));
      const existed = await pathExists(targetUri);
      const entry: Phase3CheckpointEntry = { path: key, existed };
      if (existed) {
        const previous = await vscode.workspace.fs.readFile(targetUri);
        entry.previousContentBase64 = Buffer.from(previous).toString('base64');
      }
      checkpointMap.set(key, entry);
    }
  }

  const checkpoint: Phase3Checkpoint = {
    id: checkpointId,
    createdAt: new Date().toISOString(),
    workspaceRoot: root.fsPath,
    entries: [...checkpointMap.values()]
  };

  await writePhase3Checkpoint(root, checkpoint);

  const summaries: string[] = [];
  let appliedFiles = 0;
  let skippedFiles = 0;

  try {
    for (const opportunity of safeOpportunities) {
      const result = await applyOpportunityAutofix(root, opportunity);
      appliedFiles += result.applied;
      skippedFiles += result.skipped.length;
      summaries.push(`${opportunity.id}: ${result.applied} applied, ${result.skipped.length} skipped`);
    }
  } catch (error) {
    await rollbackPhase3Checkpoint(root, checkpoint);
    throw new Error(`Batch apply failed and was rolled back: ${toErrorMessage(error)}`);
  }

  return { checkpointId, summaries, appliedFiles, skippedFiles, checkpoint };
}

function buildPhase3CheckpointId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `recon-phase3-${timestamp}`;
}

async function writePhase3Checkpoint(root: vscode.Uri, checkpoint: Phase3Checkpoint): Promise<void> {
  const checkpointsDir = vscode.Uri.joinPath(root, '.devpilot', 'checkpoints');
  await vscode.workspace.fs.createDirectory(checkpointsDir);

  const checkpointPath = vscode.Uri.joinPath(checkpointsDir, `${checkpoint.id}.json`);
  await vscode.workspace.fs.writeFile(
    checkpointPath,
    Buffer.from(JSON.stringify(checkpoint, null, 2), 'utf-8')
  );
}

async function rollbackLatestPhase3Checkpoint(
  root: vscode.Uri
): Promise<{ checkpointId: string; restored: number; deleted: number; missing: number } | undefined> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '.devpilot/checkpoints/recon-phase3-*.json'),
    '**/node_modules/**',
    50
  );

  if (files.length === 0) {
    return undefined;
  }

  const latest = files.sort((a, b) => b.path.localeCompare(a.path))[0];
  const raw = await vscode.workspace.fs.readFile(latest);
  const checkpoint = JSON.parse(Buffer.from(raw).toString('utf-8')) as Phase3Checkpoint;
  const result = await rollbackPhase3Checkpoint(root, checkpoint);

  return result;
}

async function rollbackPhase3Checkpoint(
  root: vscode.Uri,
  checkpoint: Phase3Checkpoint
): Promise<{ checkpointId: string; restored: number; deleted: number; missing: number }> {
  let restored = 0;
  let deleted = 0;
  let missing = 0;

  for (const entry of [...checkpoint.entries].reverse()) {
    const targetUri = vscode.Uri.joinPath(root, ...entry.path.split('/'));

    if (entry.existed) {
      if (typeof entry.previousContentBase64 === 'string') {
        const content = Buffer.from(entry.previousContentBase64, 'base64');
        await vscode.workspace.fs.writeFile(targetUri, content);
        restored += 1;
      } else {
        missing += 1;
      }
      continue;
    }

    if (await pathExists(targetUri)) {
      await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: false });
      deleted += 1;
    } else {
      missing += 1;
    }
  }

  return { checkpointId: checkpoint.id, restored, deleted, missing };
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
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

async function runManageAgentPermissionsCommand(
  context: vscode.ExtensionContext,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  if (AGENT_PERMISSIONS_PANEL) {
    AGENT_PERMISSIONS_PANEL.reveal(vscode.ViewColumn.Beside, true);
    await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL.webview);
    return;
  }

  AGENT_PERMISSIONS_PANEL = vscode.window.createWebviewPanel(
    AGENT_PERMISSIONS_PANEL_ID,
    AGENT_PERMISSIONS_PANEL_TITLE,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  AGENT_PERMISSIONS_PANEL.webview.html = getAgentPermissionsWebviewHtml();
  AGENT_PERMISSIONS_PANEL.onDidDispose(() => {
    AGENT_PERMISSIONS_PANEL = undefined;
  }, undefined, context.subscriptions);

  AGENT_PERMISSIONS_PANEL.webview.onDidReceiveMessage(async (message: { type?: string; key?: string }) => {
    if (!message?.type) {
      return;
    }

    if (message.type === 'ready' || message.type === 'refresh') {
      await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL?.webview);
      return;
    }

    if (message.type === 'add') {
      const toast = await addAgentPermissionEntries(logger);
      await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL?.webview, toast);
      return;
    }

    if (message.type === 'revoke') {
      const key = (message.key ?? '').trim();
      if (!key) {
        await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL?.webview, 'No permission key provided.');
        return;
      }

      const cfg = vscode.workspace.getConfiguration('devpilot');
      const current = new Set(cfg.get<string[]>('agentToolWorkspaceAllowed', []));
      if (!current.has(key)) {
        await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL?.webview, `Permission not found: ${key}`);
        return;
      }

      current.delete(key);
      const next = [...current].sort((a, b) => a.localeCompare(b));
      await cfg.update('agentToolWorkspaceAllowed', next, vscode.ConfigurationTarget.Workspace);
      logger.info('tools.agent_permissions_removed', { removed: [key], count: 1 });
      await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL?.webview, `Revoked ${key}.`);
      return;
    }

    if (message.type === 'clear') {
      const choice = await vscode.window.showWarningMessage(
        'Clear all workspace agent-tool permissions?',
        { modal: true },
        'Clear All',
        'Cancel'
      );

      if (choice !== 'Clear All') {
        await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL?.webview, 'Clear cancelled.');
        return;
      }

      const cfg = vscode.workspace.getConfiguration('devpilot');
      await cfg.update('agentToolWorkspaceAllowed', [], vscode.ConfigurationTarget.Workspace);
      logger.info('tools.agent_permissions_cleared', {});
      await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL?.webview, 'Cleared all agent-tool permissions.');
    }
  }, undefined, context.subscriptions);

  await publishAgentPermissionsState(AGENT_PERMISSIONS_PANEL.webview);
}

async function addAgentPermissionEntries(logger: ReturnType<typeof createLogger>): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('devpilot');
  const current = new Set(cfg.get<string[]>('agentToolWorkspaceAllowed', []));

  const agentPicks = await vscode.window.showQuickPick(
    ALL_DEVPILOT_AGENTS.map((agent) => ({
      label: agent.id,
      value: agent.id,
      description: `${agent.group} - ${agent.title}`
    })),
    {
      canPickMany: true,
      placeHolder: 'Select agent(s) to grant permissions'
    }
  );

  if (!agentPicks || agentPicks.length === 0) {
    return 'Add cancelled: no agents selected.';
  }

  const toolPicks = await vscode.window.showQuickPick(
    CONFIGURABLE_TOOLS.map((tool) => ({
      label: tool.id,
      value: tool.id,
      description: `${tool.category} | risk=${tool.risk}`,
      detail: tool.description
    })),
    {
      canPickMany: true,
      placeHolder: 'Select tool(s) to allow for selected agents'
    }
  );

  if (!toolPicks || toolPicks.length === 0) {
    return 'Add cancelled: no tools selected.';
  }

  const added: string[] = [];
  for (const agent of agentPicks) {
    for (const tool of toolPicks) {
      const key = makeAgentToolKey(agent.value, tool.value);
      if (!current.has(key)) {
        current.add(key);
        added.push(key);
      }
    }
  }

  const next = [...current].sort((a, b) => a.localeCompare(b));
  await cfg.update('agentToolWorkspaceAllowed', next, vscode.ConfigurationTarget.Workspace);
  logger.info('tools.agent_permissions_added', { added, count: added.length });
  return added.length > 0
    ? `Added ${added.length} agent-tool permission(s).`
    : 'Selected permissions were already present.';
}

async function publishAgentPermissionsState(webview: vscode.Webview | undefined, toast?: string): Promise<void> {
  if (!webview) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('devpilot');
  const values = cfg.get<string[]>('agentToolWorkspaceAllowed', []).slice().sort((a, b) => a.localeCompare(b));

  const entries = values.map((key) => {
    const [agentId, toolId] = splitAgentToolKey(key);
    return {
      key,
      agentId,
      toolId
    };
  });

  webview.postMessage({
    type: 'permissionsState',
    entries,
    total: entries.length,
    toast
  });
}

function splitAgentToolKey(key: string): [string, string] {
  const index = key.indexOf(':');
  if (index <= 0 || index >= key.length - 1) {
    return [key, '(invalid key)'];
  }

  return [key.slice(0, index), key.slice(index + 1)];
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
  const workspaceGrounding = [
    'Devpilot workspace context is already provided in this request.',
    'You can rely on active-file context, selection, diagnostics, git summary, and attached file excerpts included by the extension.',
    'Do not claim you cannot access the filesystem or project context.',
    'If additional context is needed, ask for one specific file or ask the user to use "Attach Files" in Devpilot.',
    'When asked how to attach project context, explain Devpilot-native steps: use Attach Files button, keep Auto-attach current file enabled, and use Search Subagent for discovery.'
  ].join(' ');

  if (mode === 'agent') {
    return [
      'Mode: agent',
      workspaceGrounding,
      'Be action-oriented. Propose executable steps, commands, and implementation details grounded in workspace context.',
      'When file edits are required, append a tool envelope at the end using this exact format:',
      '<devpilot-tools>{"actions":[{"type":"write_file","path":"relative/path.ext","content":"full file content"}]}</devpilot-tools>',
      'Supported actions: create_directory, create_file, create_jupyter_notebook, edit_file, write_file, replace_in_file, rename_file, search_workspace, open_browser_page, navigate_page, read_page, screenshot_page, type_in_page, hover_element, run_playwright_code.',
      'If you need explicit user confirmation, append one interactive envelope at the end using JSON only: <devpilot-question>{"kind":"yes_no","question":"Apply these edits now?"}</devpilot-question>.',
      'For multiple-choice prompts use: <devpilot-question>{"kind":"single_select","question":"Choose next step","options":["Option A","Option B"]}</devpilot-question>.',
      'Use workspace-relative paths only and include valid JSON without markdown fences inside the envelope.',
      prompt
    ].join('\n\n');
  }

  if (mode === 'plan') {
    return [
      'Mode: plan',
      workspaceGrounding,
      'Respond with a clear step-by-step plan first, including assumptions, risks, and validation checkpoints before deep implementation details.',
      prompt
    ].join('\n\n');
  }

  return [
    'Mode: chat',
    workspaceGrounding,
    'Give a direct and concise assistant response tailored to the request. Prefer concrete next actions over generic capability descriptions.',
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
  config: ReturnType<typeof getDevpilotConfig>,
  logger: ReturnType<typeof createLogger>,
  agentId?: string
): Promise<{ executedCount: number; executed: string[]; skippedReason?: string }> {
  const envelope = parseAgentToolEnvelope(answer);
  if (!envelope || envelope.actions.length === 0) {
    return { executedCount: 0, executed: [] };
  }

  const enabledSet = new Set(config.enabledTools);
  const actions = envelope.actions.filter((action) => enabledSet.has(normalizeAgentToolType(action.type)));
  if (actions.length === 0) {
    return {
      executedCount: 0,
      executed: [],
      skippedReason: 'requested tools are disabled in Devpilot: Configure Tools'
    };
  }

  const hasWriteAction = actions.some((action) => WRITE_TOOL_IDS.has(normalizeAgentToolType(action.type)));
  if (!config.agentAllowFileWrites && hasWriteAction) {
    return {
      executedCount: 0,
      executed: [],
      skippedReason: 'agent file-write tools are disabled in Devpilot settings'
    };
  }

  const executed: string[] = [];
  let skippedReason: string | undefined;

  for (const action of actions) {
    const toolId = normalizeAgentToolType(action.type);
    const configuredTool = CONFIGURABLE_TOOLS.find((tool) => tool.id === toolId);
    const risk = configuredTool?.risk ?? 'execute';
    const approvalScope = getDefaultScopeForRisk(risk, config);

    const approval = await resolveToolApproval(toolId, approvalScope, config.toolApproval.workspaceAllowedTools);
    if (!approval.allowed) {
      const details = summarizeActionDetails(action);
      appendToolAudit(
        {
          ts: new Date().toISOString(),
          toolId,
          actionType: action.type,
          approval: 'blocked',
          outcome: 'skipped',
          durationMs: 0,
          details,
          error: 'approval denied',
          replayAction: action
        },
        config.toolAuditMaxEntries,
        logger
      );
      skippedReason = `approval denied for ${toolId}`;
      continue;
    }

    if (agentId) {
      const agentApproval = await resolveAgentToolApproval(agentId, toolId, config.agentToolWorkspaceAllowed);
      if (!agentApproval.allowed) {
        const details = summarizeActionDetails(action);
        appendToolAudit(
          {
            ts: new Date().toISOString(),
            toolId,
            actionType: action.type,
            approval: 'blocked',
            outcome: 'skipped',
            durationMs: 0,
            details: `${details}:agent=${agentId}`,
            error: 'agent-level approval denied',
            replayAction: action
          },
          config.toolAuditMaxEntries,
          logger
        );
        skippedReason = `agent-level approval denied for ${agentId}:${toolId}`;
        continue;
      }
    }

    const startedAt = Date.now();
    const details = summarizeActionDetails(action);
    try {
      const executionLabel = await runAgentToolAction(action);
      executed.push(executionLabel);
      appendToolAudit(
        {
          ts: new Date().toISOString(),
          toolId,
          actionType: action.type,
          approval: approval.scope,
          outcome: 'applied',
          durationMs: Date.now() - startedAt,
          details,
          replayAction: action
        },
        config.toolAuditMaxEntries,
        logger
      );
    } catch (error) {
      appendToolAudit(
        {
          ts: new Date().toISOString(),
          toolId,
          actionType: action.type,
          approval: approval.scope,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          details,
          error: toErrorMessage(error),
          replayAction: action
        },
        config.toolAuditMaxEntries,
        logger
      );
      throw error;
    }
  }

  return { executedCount: executed.length, executed, skippedReason };
}

function makeAgentToolKey(agentId: string, toolId: string): string {
  return `${agentId}:${toolId}`;
}

async function resolveAgentToolApproval(
  agentId: string,
  toolId: string,
  workspaceAllowedAgentTools: string[]
): Promise<{ allowed: boolean; scope: ToolExecutionAuditRecord['approval'] }> {
  const key = makeAgentToolKey(agentId, toolId);

  if (workspaceAllowedAgentTools.includes(key)) {
    return { allowed: true, scope: 'allowWorkspace' };
  }

  if (SESSION_ALLOWED_AGENT_TOOL_KEYS.has(key)) {
    return { allowed: true, scope: 'allowSession' };
  }

  const choice = await vscode.window.showWarningMessage(
    `Agent ${agentId} requested tool: ${toolId}`,
    { modal: true },
    'Allow Once',
    'Allow for Agent Session',
    'Allow for Agent Workspace',
    'Cancel'
  );

  if (choice === 'Allow for Agent Session') {
    SESSION_ALLOWED_AGENT_TOOL_KEYS.add(key);
    return { allowed: true, scope: 'allowSession' };
  }

  if (choice === 'Allow for Agent Workspace') {
    const cfg = vscode.workspace.getConfiguration('devpilot');
    const current = new Set(cfg.get<string[]>('agentToolWorkspaceAllowed', []));
    current.add(key);
    await cfg.update('agentToolWorkspaceAllowed', [...current].sort((a, b) => a.localeCompare(b)), vscode.ConfigurationTarget.Workspace);
    return { allowed: true, scope: 'allowWorkspace' };
  }

  if (choice === 'Allow Once') {
    return { allowed: true, scope: 'askEveryTime' };
  }

  return { allowed: false, scope: 'blocked' };
}

function getDefaultScopeForRisk(
  risk: ConfigurableTool['risk'],
  config: ReturnType<typeof getDevpilotConfig>
): ToolApprovalScope {
  if (risk === 'read') {
    return config.toolApproval.defaultReadScope;
  }

  if (risk === 'edit') {
    return config.toolApproval.defaultWriteScope;
  }

  if (risk === 'browser') {
    return config.toolApproval.defaultBrowserScope;
  }

  if (risk === 'network') {
    return config.toolApproval.defaultNetworkScope;
  }

  return config.toolApproval.defaultExecuteScope;
}

async function resolveToolApproval(
  toolId: string,
  scope: ToolApprovalScope,
  workspaceAllowedTools: string[]
): Promise<{ allowed: boolean; scope: ToolExecutionAuditRecord['approval'] }> {
  if (workspaceAllowedTools.includes(toolId)) {
    return { allowed: true, scope: 'allowWorkspace' };
  }

  if (SESSION_ALLOWED_TOOL_IDS.has(toolId)) {
    return { allowed: true, scope: 'allowSession' };
  }

  if (scope === 'allowWorkspace') {
    return { allowed: true, scope: 'allowWorkspace' };
  }

  if (scope === 'allowSession') {
    return { allowed: true, scope: 'allowSession' };
  }

  const choice = await vscode.window.showWarningMessage(
    `Devpilot agent requested tool: ${toolId}`,
    { modal: true },
    'Allow Once',
    'Allow for Session',
    'Allow for Workspace',
    'Cancel'
  );

  if (choice === 'Allow for Session') {
    SESSION_ALLOWED_TOOL_IDS.add(toolId);
    return { allowed: true, scope: 'allowSession' };
  }

  if (choice === 'Allow for Workspace') {
    const cfg = vscode.workspace.getConfiguration('devpilot');
    const current = new Set(cfg.get<string[]>('toolApproval.workspaceAllowedTools', []));
    current.add(toolId);
    await cfg.update('toolApproval.workspaceAllowedTools', [...current].sort((a, b) => a.localeCompare(b)), vscode.ConfigurationTarget.Workspace);
    return { allowed: true, scope: 'allowWorkspace' };
  }

  if (choice === 'Allow Once') {
    return { allowed: true, scope: 'askEveryTime' };
  }

  return { allowed: false, scope: 'blocked' };
}

function summarizeActionDetails(action: AgentToolAction): string {
  const toolId = normalizeAgentToolType(action.type);
  if ('query' in action && typeof action.query === 'string') {
    return `${toolId}:query=${action.query.slice(0, 120)}`;
  }

  if ('path' in action && typeof action.path === 'string') {
    return `${toolId}:path=${action.path}`;
  }

  if ('pageId' in action && typeof action.pageId === 'string') {
    return `${toolId}:pageId=${action.pageId}`;
  }

  if ('url' in action && typeof action.url === 'string') {
    return `${toolId}:url=${action.url}`;
  }

  return toolId;
}

function appendToolAudit(
  record: ToolExecutionAuditRecord,
  maxEntries: number,
  logger: ReturnType<typeof createLogger>
): void {
  if (!record.id) {
    TOOL_AUDIT_SEQ += 1;
    record.id = TOOL_AUDIT_SEQ;
  }

  TOOL_EXECUTION_AUDIT.push(record);
  if (TOOL_EXECUTION_AUDIT.length > maxEntries) {
    TOOL_EXECUTION_AUDIT.splice(0, TOOL_EXECUTION_AUDIT.length - maxEntries);
  }

  logger.info('tools.audit', {
    toolId: record.toolId,
    actionType: record.actionType,
    approval: record.approval,
    outcome: record.outcome,
    durationMs: record.durationMs,
    details: record.details,
    error: record.error
  });

  publishToolAuditState(TOOL_AUDIT_PANEL?.webview);
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

  if (toolType === 'search_workspace') {
    const query = getActionQuery(action);
    const includePattern = normalizeIncludePattern(getActionIncludePattern(action));
    const maxResults = getActionMaxResults(action);
    const hits = await searchWorkspaceSnippets(query, includePattern, maxResults);
    return `${toolType}:${hits.length}hits:query=${query.slice(0, 60)}`;
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

  if (type === 'searchWorkspace') {
    return 'search_workspace';
  }

  return type;
}

async function searchWorkspaceSnippets(
  query: string,
  includePattern: string | undefined,
  maxResults: number
): Promise<WorkspaceSearchHit[]> {
  const hits: WorkspaceSearchHit[] = [];

  const includeGlob = includePattern && includePattern.length > 0 ? includePattern : '**/*';
  const excludeGlob = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**}';
  const safeMaxResults = Math.max(1, Math.min(200, maxResults));
  const files = await vscode.workspace.findFiles(includeGlob, excludeGlob, 400);
  const normalizedQuery = query.toLowerCase();

  for (const file of files) {
    if (hits.length >= safeMaxResults) {
      break;
    }

    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      if (bytes.length > 1_000_000) {
        continue;
      }

      content = Buffer.from(bytes).toString('utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (hits.length >= safeMaxResults) {
        break;
      }

      const lineText = lines[lineIndex];
      if (!lineText.toLowerCase().includes(normalizedQuery)) {
        continue;
      }

      hits.push({
        path: vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/'),
        line: lineIndex + 1,
        preview: lineText.replace(/\s+/g, ' ').trim()
      });
    }
  }

  return hits;
}

function normalizeIncludePattern(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\\/g, '/');
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

function getActionQuery(action: AgentToolAction): string {
  if ('query' in action && typeof action.query === 'string' && action.query.trim().length > 0) {
    return action.query.trim();
  }

  throw new Error(`Tool action ${action.type} is missing required field: query`);
}

function getActionIncludePattern(action: AgentToolAction): string | undefined {
  if ('includePattern' in action && typeof action.includePattern === 'string') {
    return action.includePattern;
  }

  return undefined;
}

function getActionMaxResults(action: AgentToolAction): number {
  if ('maxResults' in action && typeof action.maxResults === 'number' && Number.isFinite(action.maxResults)) {
    return Math.max(1, Math.min(200, Math.trunc(action.maxResults)));
  }

  return 25;
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

async function buildInlineSuggestionPayload(
  request: InlineLlmSuggestionRequest,
  config: ReturnType<typeof getDevpilotConfig>
): Promise<ChatRequestPayload> {
  const doc = request.document;
  const position = request.position;

  const fullText = doc.getText();
  const useFullFileContext = config.inlineContextMode === 'fullFileWhenSmall' && fullText.length <= config.inlineMaxFileChars;
  const startLine = useFullFileContext ? 0 : Math.max(0, position.line - 30);
  const endLine = useFullFileContext ? Math.max(0, doc.lineCount - 1) : Math.min(doc.lineCount - 1, position.line + 24);
  const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
  const snippetText = doc.getText(range);
  const surroundingContent = injectCursorMarker(snippetText, startLine, position).slice(0, useFullFileContext ? config.inlineMaxFileChars + 256 : 12000);
  const currentLineSuffix = doc.lineAt(position.line).text.slice(position.character, position.character + 120);
  const localDiagnostics = summarizeInlineDiagnostics(doc.uri, position.line);
  const importedFiles = config.inlineIncludeImportedFiles
    ? await resolveImportedInlineAttachments(doc, config.inlineImportedFilesLimit, 1400)
    : [];
  const inlineAttachments = [...request.attachedFiles, ...importedFiles]
    .filter((file, index, all) => all.findIndex((other) => other.path === file.path) === index)
    .slice(0, 4)
    .map((file) => ({ ...file, content: file.content.slice(0, 1400) }));

  const promptBase = [
    'You are completing code inline in VS Code.',
    'Return only the continuation text to insert at cursor.',
    'Prefer short, syntactically-correct continuations over long rewrites.',
    'The context includes <|cursor|> marker. Continue exactly at that marker position.',
    'Preserve surrounding function/block structure and indentation.',
    'Do not duplicate return statements, decorators, imports, or closing braces/brackets.',
    'Do not repeat lines or statements.',
    'If you produce multiple lines, keep them structurally valid and properly separated by newlines.',
    'Do not use markdown, backticks, explanations, comments, or repeated prefix.',
    `Current line prefix: ${request.linePrefix}`,
    `Current line suffix: ${currentLineSuffix || '(none)'}`,
    `Context mode: ${useFullFileContext ? 'full-file' : 'window'}`,
    `Language: ${doc.languageId}`
  ].join('\n');

  const promptWithAttachments = enrichPromptWithAttachments(promptBase, inlineAttachments);
  const prompt = config.enableGuardrails ? sanitizePrompt(promptWithAttachments) : promptWithAttachments;

  const context: ChatContextPayload = {
    activeFile: doc.fileName,
    languageId: doc.languageId,
    cursor: `line ${position.line + 1}, col ${position.character + 1}`,
    selectionSummary: `Selection: (none)`,
    selectionRange: `start(${position.line + 1}:${position.character + 1}) end(${position.line + 1}:${position.character + 1})`,
    activeFileContent: config.enableGuardrails ? sanitizeContextString(surroundingContent) : surroundingContent,
    diagnosticsSummary: localDiagnostics,
    gitDiffSummary: '(inline suggestion path) git diff omitted for latency'
  };

  return {
    prompt,
    context
  };
}

async function resolveImportedInlineAttachments(
  document: vscode.TextDocument,
  maxFiles: number,
  maxCharsPerFile: number
): Promise<AttachedFileContext[]> {
  if (maxFiles <= 0) {
    return [];
  }

  const importSpecifiers = extractRelativeImportSpecifiers(document.getText(), document.languageId);
  if (importSpecifiers.length === 0) {
    return [];
  }

  const results: AttachedFileContext[] = [];
  for (const specifier of importSpecifiers) {
    if (results.length >= maxFiles) {
      break;
    }

    const filePath = await resolveImportSpecifierToFile(document.fileName, document.languageId, specifier);
    if (!filePath) {
      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const content = Buffer.from(bytes).toString('utf8').slice(0, maxCharsPerFile);
      results.push({
        path: filePath,
        name: path.basename(filePath),
        content
      });
    } catch {
      // Ignore unreadable imported files in inline mode.
    }
  }

  return results;
}

function extractRelativeImportSpecifiers(source: string, languageId: string): string[] {
  const values = new Set<string>();

  if (languageId === 'javascript' || languageId === 'javascriptreact' || languageId === 'typescript' || languageId === 'typescriptreact') {
    const importFrom = /from\s+['"]([^'"\n]+)['"]/g;
    const importOnly = /import\s+['"]([^'"\n]+)['"]/g;
    const requireCall = /require\(\s*['"]([^'"\n]+)['"]\s*\)/g;
    for (const regex of [importFrom, importOnly, requireCall]) {
      let match = regex.exec(source);
      while (match) {
        if (match[1].startsWith('.')) {
          values.add(match[1]);
        }
        match = regex.exec(source);
      }
    }
  }

  if (languageId === 'python') {
    const fromImport = /^\s*from\s+([.][A-Za-z0-9_\.]+)\s+import\s+/gm;
    let match = fromImport.exec(source);
    while (match) {
      values.add(match[1]);
      match = fromImport.exec(source);
    }
  }

  return [...values];
}

async function resolveImportSpecifierToFile(
  currentFilePath: string,
  languageId: string,
  specifier: string
): Promise<string | undefined> {
  const fromDir = path.dirname(currentFilePath);

  if (languageId === 'python') {
    return await resolvePythonRelativeImport(fromDir, specifier);
  }

  const base = path.resolve(fromDir, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx')
  ];

  return await firstExistingFile(candidates);
}

async function resolvePythonRelativeImport(fromDir: string, specifier: string): Promise<string | undefined> {
  const match = specifier.match(/^(\.+)(.*)$/);
  if (!match) {
    return undefined;
  }

  const dots = match[1].length;
  const remainder = (match[2] || '').replace(/\./g, path.sep);
  let baseDir = fromDir;
  for (let i = 1; i < dots; i += 1) {
    baseDir = path.dirname(baseDir);
  }

  const base = remainder ? path.join(baseDir, remainder) : baseDir;
  const candidates = [
    `${base}.py`,
    path.join(base, '__init__.py')
  ];

  return await firstExistingFile(candidates);
}

async function firstExistingFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      if (stat.type === vscode.FileType.File) {
        return candidate;
      }
    } catch {
      // Candidate missing.
    }
  }

  return undefined;
}

function injectCursorMarker(snippetText: string, snippetStartLine: number, position: vscode.Position): string {
  const lines = snippetText.split('\n');
  const relativeLine = position.line - snippetStartLine;
  if (relativeLine < 0 || relativeLine >= lines.length) {
    return snippetText;
  }

  const target = lines[relativeLine] ?? '';
  const safeChar = Math.max(0, Math.min(position.character, target.length));
  lines[relativeLine] = `${target.slice(0, safeChar)}<|cursor|>${target.slice(safeChar)}`;
  return lines.join('\n');
}

function summarizeInlineDiagnostics(uri: vscode.Uri, cursorLine: number): string {
  const relevant = vscode.languages
    .getDiagnostics(uri)
    .filter((diag) => {
      if (diag.severity !== vscode.DiagnosticSeverity.Error && diag.severity !== vscode.DiagnosticSeverity.Warning) {
        return false;
      }

      return Math.abs(diag.range.start.line - cursorLine) <= 2;
    })
    .slice(0, 5)
    .map((diag) => {
      const severity = diag.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      return `${severity} at line ${diag.range.start.line + 1}: ${diag.message}`;
    });

  if (relevant.length === 0) {
    return '(inline suggestion path) no nearby diagnostics';
  }

  return relevant.join('\n');
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
    <div class="msg">Ask a question to start. I can use active-file context and attached files. Use Attach Files for extra docs and keep Auto-attach current file on for fast results.</div>
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

function getToolAuditWebviewHtml(): string {
  return /* html */ `
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Devpilot Tool Audit Timeline</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0f1f;
      color: #e8efff;
    }
    .wrap {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .header {
      padding: 12px;
      border-bottom: 1px solid #24355f;
      background: linear-gradient(180deg, #122041 0%, #0a0f1f 100%);
    }
    .title {
      font-weight: 700;
      font-size: 14px;
    }
    .subtitle {
      color: #95a8d8;
      font-size: 12px;
      margin-top: 2px;
    }
    .controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .controls button,
    .controls select,
    .controls input {
      border: 1px solid #314b83;
      background: #101a32;
      color: #e8efff;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
    }
    .controls button {
      cursor: pointer;
      background: #2453c9;
      border-color: #3d66d1;
      font-weight: 600;
    }
    .controls button.secondary {
      background: #1a274a;
      border-color: #2a3f74;
    }
    .rowAction {
      margin-right: 6px;
      margin-bottom: 4px;
      cursor: pointer;
      border: 1px solid #314b83;
      background: #1a274a;
      color: #e8efff;
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
    }
    .rowAction:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(80px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .card {
      background: #101a32;
      border: 1px solid #24355f;
      border-radius: 8px;
      padding: 8px;
    }
    .card .label {
      color: #95a8d8;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .card .value {
      font-size: 16px;
      font-weight: 700;
      margin-top: 2px;
    }
    .tableWrap {
      padding: 12px;
      overflow: auto;
      flex: 1;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid #1f2f57;
      text-align: left;
      padding: 8px 6px;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: #0f1933;
      color: #a8b9e8;
      font-weight: 600;
      z-index: 1;
    }
    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
    }
    .pill.applied { background: #163d2d; color: #93f0c0; }
    .pill.failed { background: #4a1d25; color: #ffc3ce; }
    .pill.skipped { background: #4a3c1a; color: #ffe4aa; }
    .muted {
      color: #95a8d8;
      font-size: 11px;
    }
    .toast {
      margin-top: 8px;
      color: #9fd6ff;
      font-size: 12px;
      min-height: 18px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="title">Devpilot Tool Audit Timeline</div>
      <div class="subtitle">Recent tool events, outcomes, approvals, and timings</div>
      <div class="controls">
        <button id="refresh">Refresh</button>
        <button id="export" class="secondary">Export JSON</button>
        <button id="clear" class="secondary">Clear</button>
        <select id="outcomeFilter">
          <option value="all">All outcomes</option>
          <option value="applied">Applied</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </select>
        <input id="textFilter" type="text" placeholder="Filter tool/details" />
      </div>
      <div class="summary">
        <div class="card"><div class="label">Total</div><div class="value" id="totalCount">0</div></div>
        <div class="card"><div class="label">Applied</div><div class="value" id="appliedCount">0</div></div>
        <div class="card"><div class="label">Failed</div><div class="value" id="failedCount">0</div></div>
        <div class="card"><div class="label">Skipped</div><div class="value" id="skippedCount">0</div></div>
      </div>
      <div id="toast" class="toast"></div>
    </div>
    <div class="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Outcome</th>
            <th>Tool</th>
            <th>Approval</th>
            <th>Duration</th>
            <th>Details</th>
            <th>Error</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const rowsEl = document.getElementById('rows');
    const toastEl = document.getElementById('toast');
    const outcomeFilterEl = document.getElementById('outcomeFilter');
    const textFilterEl = document.getElementById('textFilter');
    const totalCountEl = document.getElementById('totalCount');
    const appliedCountEl = document.getElementById('appliedCount');
    const failedCountEl = document.getElementById('failedCount');
    const skippedCountEl = document.getElementById('skippedCount');

    let entries = [];

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function applyFilters() {
      const outcome = outcomeFilterEl.value;
      const text = textFilterEl.value.trim().toLowerCase();
      const filtered = entries.filter((entry) => {
        if (outcome !== 'all' && entry.outcome !== outcome) {
          return false;
        }

        if (!text) {
          return true;
        }

        const haystack = [entry.toolId, entry.actionType, entry.details, entry.error || ''].join(' ').toLowerCase();
        return haystack.includes(text);
      });

      rowsEl.innerHTML = filtered
        .slice()
        .reverse()
        .map((entry) => {
          const outcomeClass = entry.outcome === 'applied' ? 'applied' : (entry.outcome === 'failed' ? 'failed' : 'skipped');
          const copyDisabled = entry.hasReplayAction ? '' : ' disabled';
          const rerunDisabled = entry.canReplay ? '' : ' disabled';
          return '<tr>' +
            '<td>' + escapeHtml(new Date(entry.ts).toLocaleTimeString()) + '<div class="muted">' + escapeHtml(new Date(entry.ts).toLocaleDateString()) + '</div></td>' +
            '<td><span class="pill ' + outcomeClass + '">' + escapeHtml(entry.outcome) + '</span></td>' +
            '<td>' + escapeHtml(entry.toolId) + '<div class="muted">' + escapeHtml(entry.actionType) + '</div></td>' +
            '<td>' + escapeHtml(entry.approval) + '</td>' +
            '<td>' + escapeHtml(entry.durationMs) + ' ms</td>' +
            '<td>' + escapeHtml(entry.details) + '</td>' +
            '<td>' + escapeHtml(entry.error || '') + '</td>' +
            '<td>' +
              '<button class="rowAction" data-action="copy" data-id="' + escapeHtml(entry.id) + '"' + copyDisabled + '>Copy Action</button>' +
              '<button class="rowAction" data-action="rerun" data-id="' + escapeHtml(entry.id) + '"' + rerunDisabled + '>Rerun Safe</button>' +
            '</td>' +
            '</tr>';
        })
        .join('');
    }

    function setSummary(summary) {
      totalCountEl.textContent = String(summary.total || 0);
      appliedCountEl.textContent = String(summary.applied || 0);
      failedCountEl.textContent = String(summary.failed || 0);
      skippedCountEl.textContent = String(summary.skipped || 0);
    }

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('export').addEventListener('click', () => {
      vscode.postMessage({ type: 'export' });
    });

    document.getElementById('clear').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    rowsEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (!target.classList.contains('rowAction')) {
        return;
      }

      const action = target.dataset.action;
      const id = Number(target.dataset.id || '');
      if (!Number.isInteger(id)) {
        return;
      }

      if (action === 'copy') {
        vscode.postMessage({ type: 'copyAction', id });
        return;
      }

      if (action === 'rerun') {
        vscode.postMessage({ type: 'rerunAction', id });
      }
    });

    outcomeFilterEl.addEventListener('change', applyFilters);
    textFilterEl.addEventListener('input', applyFilters);

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'auditState') {
        return;
      }

      entries = Array.isArray(message.entries) ? message.entries : [];
      setSummary(message.summary || {});
      toastEl.textContent = message.toast || '';
      applyFilters();
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>
`;
}

function getAgentPermissionsWebviewHtml(): string {
  return /* html */ `
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Devpilot Agent Permissions</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0f1f;
      color: #e8efff;
    }
    .wrap {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .header {
      padding: 12px;
      border-bottom: 1px solid #24355f;
      background: linear-gradient(180deg, #122041 0%, #0a0f1f 100%);
    }
    .title {
      font-weight: 700;
      font-size: 14px;
    }
    .subtitle {
      color: #95a8d8;
      font-size: 12px;
      margin-top: 2px;
    }
    .controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .controls button,
    .controls input {
      border: 1px solid #314b83;
      background: #101a32;
      color: #e8efff;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
    }
    .controls button {
      cursor: pointer;
      background: #2453c9;
      border-color: #3d66d1;
      font-weight: 600;
    }
    .controls button.secondary {
      background: #1a274a;
      border-color: #2a3f74;
    }
    .controls button.danger {
      background: #5a2230;
      border-color: #8a3c52;
    }
    .summary {
      margin-top: 8px;
      color: #95a8d8;
      font-size: 12px;
    }
    .toast {
      margin-top: 8px;
      color: #9fd6ff;
      font-size: 12px;
      min-height: 18px;
    }
    .tableWrap {
      padding: 12px;
      overflow: auto;
      flex: 1;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid #1f2f57;
      text-align: left;
      padding: 8px 6px;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: #0f1933;
      color: #a8b9e8;
      font-weight: 600;
      z-index: 1;
    }
    .rowAction {
      cursor: pointer;
      border: 1px solid #8a3c52;
      background: #5a2230;
      color: #ffd5de;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
    }
    .muted {
      color: #95a8d8;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="title">Devpilot Agent Permissions</div>
      <div class="subtitle">Workspace-scoped agent tool approvals in format agentId:toolId</div>
      <div class="controls">
        <button id="add">Add Permissions</button>
        <button id="refresh" class="secondary">Refresh</button>
        <button id="clear" class="danger">Clear All</button>
        <input id="filter" type="text" placeholder="Filter by agent or tool" />
      </div>
      <div class="summary">Total permissions: <span id="total">0</span></div>
      <div id="toast" class="toast"></div>
    </div>
    <div class="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Tool</th>
            <th>Key</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const rowsEl = document.getElementById('rows');
    const totalEl = document.getElementById('total');
    const filterEl = document.getElementById('filter');
    const toastEl = document.getElementById('toast');
    let entries = [];

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function applyFilter() {
      const text = filterEl.value.trim().toLowerCase();
      const filtered = entries.filter((entry) => {
        if (!text) {
          return true;
        }

        const haystack = [entry.agentId, entry.toolId, entry.key].join(' ').toLowerCase();
        return haystack.includes(text);
      });

      rowsEl.innerHTML = filtered
        .map((entry) => {
          return '<tr>' +
            '<td>' + escapeHtml(entry.agentId) + '</td>' +
            '<td>' + escapeHtml(entry.toolId) + '</td>' +
            '<td><span class="muted">' + escapeHtml(entry.key) + '</span></td>' +
            '<td><button class="rowAction" data-key="' + escapeHtml(entry.key) + '">Revoke</button></td>' +
            '</tr>';
        })
        .join('');
    }

    document.getElementById('add').addEventListener('click', () => {
      vscode.postMessage({ type: 'add' });
    });

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('clear').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    filterEl.addEventListener('input', applyFilter);

    rowsEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (!target.classList.contains('rowAction')) {
        return;
      }

      const key = target.dataset.key || '';
      if (!key) {
        return;
      }

      vscode.postMessage({ type: 'revoke', key });
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'permissionsState') {
        return;
      }

      entries = Array.isArray(message.entries) ? message.entries : [];
      totalEl.textContent = String(message.total || entries.length);
      toastEl.textContent = message.toast || '';
      applyFilter();
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>
`;
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
