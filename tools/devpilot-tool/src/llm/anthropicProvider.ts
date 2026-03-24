import { randomUUID } from 'node:crypto';
import { LlmChatInput, LlmChatResult, LlmProviderClient } from './types';

interface AnthropicMessagesResponse {
  id?: string;
  model?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface AnthropicModelsResponse {
  data?: Array<{ id?: string }>;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl: string;
}

export class AnthropicProviderClient implements LlmProviderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  public async chat(input: LlmChatInput, signal: AbortSignal): Promise<LlmChatResult> {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1200,
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

    const body = (await response.json()) as AnthropicMessagesResponse;
    const answer = (body.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();

    if (!answer) {
      throw new Error('Anthropic response did not include text content.');
    }

    return {
      answer,
      model: body.model ?? input.model,
      requestId: body.id ?? randomUUID()
    };
  }

  public async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as AnthropicModelsResponse;
    const models = (body.data ?? [])
      .map((item) => item.id?.trim() ?? '')
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));

    if (models.length === 0) {
      throw new Error('No models were returned by provider.');
    }

    return models;
  }
}
