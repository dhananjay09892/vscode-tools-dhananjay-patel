import { LlmProviderClient } from './types';

export type SupportedProviderId = 'local' | 'openai' | 'anthropic' | 'groq' | 'openrouter' | 'ollama';

export interface ProviderDescriptor {
  id: SupportedProviderId;
  label: string;
  defaultModel: string;
  supportsRemoteModels: boolean;
  requiresApiKey: boolean;
}

const PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'local',
    label: 'Local Devpilot Backend',
    defaultModel: 'devpilot-local-backend-v1',
    supportsRemoteModels: false,
    requiresApiKey: false
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    supportsRemoteModels: true,
    requiresApiKey: true
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-3-5-sonnet-latest',
    supportsRemoteModels: true,
    requiresApiKey: true
  },
  {
    id: 'groq',
    label: 'Groq (OpenAI-compatible)',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsRemoteModels: true,
    requiresApiKey: true
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (OpenAI-compatible)',
    defaultModel: 'openai/gpt-4o-mini',
    supportsRemoteModels: true,
    requiresApiKey: true
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'llama3.1:8b',
    supportsRemoteModels: true,
    requiresApiKey: false
  }
];

export function listSupportedProviders(): ProviderDescriptor[] {
  return [...PROVIDERS];
}

export function isSupportedProviderId(value: string): value is SupportedProviderId {
  return PROVIDERS.some((provider) => provider.id === value);
}

export function getProviderDescriptor(id: SupportedProviderId): ProviderDescriptor {
  const found = PROVIDERS.find((provider) => provider.id === id);
  if (!found) {
    throw new Error(`Unsupported provider: ${id}`);
  }

  return found;
}

export function createProviderClient(
  providerId: SupportedProviderId,
  params: {
    apiKey?: string;
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    groqBaseUrl: string;
    openrouterBaseUrl: string;
    ollamaBaseUrl: string;
  }
): LlmProviderClient | undefined {
  if (providerId === 'openai') {
    if (!params.apiKey) {
      throw new Error('OpenAI API key is missing. Run Devpilot: Configure LLM first.');
    }

    const { OpenAIProviderClient } = require('./openaiProvider') as typeof import('./openaiProvider');
    return new OpenAIProviderClient({
      apiKey: params.apiKey,
      baseUrl: params.openaiBaseUrl
    });
  }

  if (providerId === 'anthropic') {
    if (!params.apiKey) {
      throw new Error('Anthropic API key is missing. Run Devpilot: Configure LLM first.');
    }

    const { AnthropicProviderClient } = require('./anthropicProvider') as typeof import('./anthropicProvider');
    return new AnthropicProviderClient({
      apiKey: params.apiKey,
      baseUrl: params.anthropicBaseUrl
    });
  }

  if (providerId === 'groq') {
    if (!params.apiKey) {
      throw new Error('Groq API key is missing. Run Devpilot: Configure LLM first.');
    }

    const { OpenAIProviderClient } = require('./openaiProvider') as typeof import('./openaiProvider');
    return new OpenAIProviderClient({
      apiKey: params.apiKey,
      baseUrl: params.groqBaseUrl
    });
  }

  if (providerId === 'openrouter') {
    if (!params.apiKey) {
      throw new Error('OpenRouter API key is missing. Run Devpilot: Configure LLM first.');
    }

    const { OpenAIProviderClient } = require('./openaiProvider') as typeof import('./openaiProvider');
    return new OpenAIProviderClient({
      apiKey: params.apiKey,
      baseUrl: params.openrouterBaseUrl
    });
  }

  if (providerId === 'ollama') {
    const { OllamaProviderClient } = require('./ollamaProvider') as typeof import('./ollamaProvider');
    return new OllamaProviderClient({
      baseUrl: params.ollamaBaseUrl
    });
  }

  return undefined;
}
