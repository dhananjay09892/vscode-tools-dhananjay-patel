import * as vscode from 'vscode';

export interface DevpilotLogger {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
}

export function createLogger(output: vscode.OutputChannel): DevpilotLogger {
  const write = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => {
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data
    };

    output.appendLine(JSON.stringify(record));
  };

  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data)
  };
}
