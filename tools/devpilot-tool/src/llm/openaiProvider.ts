import { randomUUID } from 'node:crypto';
import { LlmChatInput, LlmChatResult, LlmProviderClient } from './types';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl: string;
}

const DEFAULT_COMPLETION_TOKENS = 1200;

export class OpenAIProviderClient implements LlmProviderClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  public constructor(options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
  }

  public async chat(input: LlmChatInput, signal: AbortSignal): Promise<LlmChatResult> {
    try {
      return await this.chatViaResponsesApi(input, signal);
    } catch (error) {
      const maybeMessage = error instanceof Error ? error.message : String(error);
      if (!maybeMessage.includes('HTTP 404')) {
        throw error;
      }
    }

    return await this.chatViaChatCompletionsApi(input, signal);
  }

  private async chatViaResponsesApi(input: LlmChatInput, signal: AbortSignal): Promise<LlmChatResult> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: input.model,
        input: `${input.prompt}\n\n${input.contextEnvelope}`
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(await this.buildHttpError(response, `${this.baseUrl}/responses`));
    }

    const body = (await response.json()) as OpenAIResponsesApiResponse;
    const answer = extractResponsesApiText(body);
    if (!answer) {
      throw new Error('OpenAI responses API did not include readable text output.');
    }

    return {
      answer,
      model: body.model ?? input.model,
      requestId: body.id ?? randomUUID()
    };
  }

  private async chatViaChatCompletionsApi(input: LlmChatInput, signal: AbortSignal): Promise<LlmChatResult> {
    const useCompletionTokens = isGpt5Model(input.model);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: 'system',
            content: 'You are Devpilot, a helpful coding assistant.'
          },
          {
            role: 'user',
            content: `${input.prompt}\n\n${input.contextEnvelope}`
          }
        ],
        ...(useCompletionTokens
          ? { max_completion_tokens: DEFAULT_COMPLETION_TOKENS }
          : { max_tokens: DEFAULT_COMPLETION_TOKENS })
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(await this.buildHttpError(response, `${this.baseUrl}/chat/completions`));
    }

    const body = (await response.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const answer = body.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      throw new Error('OpenAI response did not include message content.');
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
        Authorization: `Bearer ${this.apiKey}`
      },
      signal
    });

    if (!response.ok) {
      throw new Error(await this.buildHttpError(response, `${this.baseUrl}/models`));
    }

    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? [])
      .map((item) => item.id?.trim() ?? '')
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));

    if (models.length === 0) {
      throw new Error('No models were returned by provider.');
    }

    return models;
  }

  private async buildHttpError(response: Response, endpoint: string): Promise<string> {
    let suffix = '';

    try {
      const raw = await response.text();
      const trimmed = raw.trim();
      if (trimmed) {
        const json = JSON.parse(trimmed) as { error?: { message?: string } };
        const providerMessage = json.error?.message?.trim();
        if (providerMessage) {
          suffix = ` - ${providerMessage}`;
        }
    }
    } catch {
      // Best effort parsing.
    }

    return `HTTP ${response.status} on ${endpoint}${suffix}`;
  }
}

interface OpenAIResponsesApiResponse {
  id?: string;
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

function isGpt5Model(model: string): boolean {
  return model.trim().toLowerCase().startsWith('gpt-5');
}

function extractResponsesApiText(body: OpenAIResponsesApiResponse): string | undefined {
  const direct = body.output_text?.trim();
  if (direct) {
    return direct;
  }

  const nested = (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text' || content.type === 'text')
    .map((content) => content.text?.trim() ?? '')
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();

  return nested || undefined;
}
