export interface LlmChatInput {
  prompt: string;
  contextEnvelope: string;
  model: string;
}

export interface LlmChatResult {
  answer: string;
  model: string;
  requestId?: string;
}

export interface LlmProviderClient {
  chat(input: LlmChatInput, signal: AbortSignal): Promise<LlmChatResult>;
  listModels(signal: AbortSignal): Promise<string[]>;
}
