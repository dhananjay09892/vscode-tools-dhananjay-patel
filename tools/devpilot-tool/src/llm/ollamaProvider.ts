import { randomUUID } from 'node:crypto';
import { LlmChatInput, LlmChatResult, LlmProviderClient } from './types';

interface OllamaChatResponse {
  model?: string;
  message?: {
    content?: string;
  };
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

export interface OllamaProviderOptions {
  baseUrl: string;
}

export class OllamaProviderClient implements LlmProviderClient {
  private readonly baseUrl: string;

  public constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  public async chat(input: LlmChatInput, signal: AbortSignal): Promise<LlmChatResult> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        messages: [
          {
            role: 'user',
            content: `${input.prompt}\n\n${input.contextEnvelope}`
          }
        ]
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as OllamaChatResponse;
    const answer = body.message?.content?.trim();

    if (!answer) {
      throw new Error('Ollama response did not include message content.');
    }

    return {
      answer,
      model: body.model ?? input.model,
      requestId: randomUUID()
    };
  }

  public async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      method: 'GET',
      signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as OllamaTagsResponse;
    const models = (body.models ?? [])
      .map((item) => item.name?.trim() ?? '')
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));

    if (models.length === 0) {
      throw new Error('No models were returned by provider.');
    }

    return models;
  }
}
