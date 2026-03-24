import { ChatContextPayload } from './chatBackend';

const REDACTION_TOKEN = '[REDACTED]';

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /(api[_-]?key\s*[:=]\s*)([^\s"']+)/gi,
  /(token\s*[:=]\s*)([^\s"']+)/gi,
  /(password\s*[:=]\s*)([^\s"']+)/gi
];

export function sanitizePrompt(input: string): string {
  const noControls = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  const compact = noControls.replace(/\s+/g, ' ').trim();
  return redactSecrets(compact).slice(0, 4000);
}

export function sanitizeContext(context: ChatContextPayload): ChatContextPayload {
  return {
    ...context,
    selectionSummary: redactSecrets(context.selectionSummary),
    activeFileContent: redactSecrets(context.activeFileContent),
    diagnosticsSummary: redactSecrets(context.diagnosticsSummary),
    gitDiffSummary: redactSecrets(context.gitDiffSummary)
  };
}

function redactSecrets(text: string): string {
  let result = text;

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix) => {
      if (typeof prefix === 'string') {
        return `${prefix}${REDACTION_TOKEN}`;
      }

      return REDACTION_TOKEN;
    });
  }

  return result;
}
