import * as http from 'node:http';
import { randomUUID } from 'node:crypto';

export interface ChatContextPayload {
  activeFile: string;
  languageId: string;
  cursor: string;
  selectionSummary: string;
  selectionRange: string;
  activeFileContent: string;
  diagnosticsSummary: string;
  gitDiffSummary: string;
}

export interface ChatRequestPayload {
  prompt: string;
  context: ChatContextPayload;
}

export interface ChatResponsePayload {
  answer: string;
  requestId: string;
  model: string;
}

export interface RunningBackend {
  baseUrl: string;
  dispose: () => Promise<void>;
}

export async function startChatBackend(): Promise<RunningBackend> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const payload = JSON.parse(raw) as ChatRequestPayload;

        const prompt = (payload.prompt ?? '').trim();
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'prompt is required' }));
          return;
        }

        const requestId = randomUUID();
        const answer = [
          'Devpilot backend response:',
          `Prompt: "${prompt}"`,
          `Active file: ${payload.context.activeFile}`,
          `Language: ${payload.context.languageId}`,
          `Cursor: ${payload.context.cursor}`,
          payload.context.selectionSummary,
          `Selection range: ${payload.context.selectionRange}`,
          `Diagnostics:\n${payload.context.diagnosticsSummary}`,
          `Git diff:\n${payload.context.gitDiffSummary}`,
          `File content chars sent: ${payload.context.activeFileContent.length}`,
          'Status: Milestone 3 context engine path is active.'
        ].join('\n');

        const response: ChatResponsePayload = {
          answer,
          requestId,
          model: 'devpilot-local-backend-v1'
        };

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(response));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid json payload' }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start Devpilot backend.');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    dispose: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}
