export interface QuickActionItem {
  label: string;
  command: string;
}

export interface ErrorContext {
  providerId?: string;
}

export function buildQuickActionItems(): QuickActionItem[] {
  return [
    { label: 'Open Chat', command: 'devpilot.openChat' },
    { label: 'Open Settings', command: 'devpilot.openSettings' },
    { label: 'Tool Audit Timeline', command: 'devpilot.showToolAudit' },
    { label: 'Search Subagent', command: 'devpilot.searchSubagent' },
    { label: 'Agent Swarm', command: 'devpilot.agentSwarm' },
    { label: 'Configure Tools', command: 'devpilot.configureTools' },
    { label: 'Manage Agent Permissions', command: 'devpilot.manageAgentPermissions' },
    { label: 'Toggle Inline Suggestions', command: 'devpilot.toggleInlineSuggestions' },
    { label: 'Configure LLM', command: 'devpilot.configureLlm' },
    { label: 'Attach Files', command: 'devpilot.attachFiles' },
    { label: 'Recon and Plan', command: 'devpilot.reconAndPlan' },
    { label: 'Analyze Current File', command: 'devpilot.analyzeCurrentFile' },
    { label: 'Explain Selection', command: 'devpilot.explainSelection' },
    { label: 'Generate Tests', command: 'devpilot.generateTests' },
    { label: 'Refactor Suggestion', command: 'devpilot.refactorSuggestion' }
  ];
}

export function toUserFriendlyError(message: string, context?: ErrorContext): string {
  const lower = message.toLowerCase();
  const providerId = (context?.providerId ?? 'local').toLowerCase();

  if (lower.includes('timed out')) {
    return 'Request timed out. Increase devpilot.requestTimeoutMs or verify backend speed.';
  }

  if (lower.includes('http 401') || lower.includes('http 403')) {
    return 'Authentication failed. Use Devpilot: Configure LLM and retry.';
  }

  if (lower.includes('http 429')) {
    return 'Provider rate limit reached (HTTP 429). Retry shortly or choose a different model.';
  }

  if (lower.includes('http 404')) {
    if (providerId === 'local') {
      return 'Chat endpoint not found. Verify devpilot.endpoint setting and backend route.';
    }

    if (providerId === 'openai' || providerId === 'groq' || providerId === 'openrouter') {
      return `Provider endpoint not found (HTTP 404) for "${providerId}". Verify the base URL includes the expected API path (typically ending in /v1).`;
    }

    return `Provider endpoint not found (HTTP 404) for "${providerId}". Verify the provider base URL setting and API compatibility.`;
  }

  if (lower.includes('fetch')) {
    return 'Network request failed. Check endpoint URL and backend availability.';
  }

  return `Unexpected error: ${message}`;
}
