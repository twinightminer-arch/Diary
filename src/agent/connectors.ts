// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError } from './provider.ts';
import type { Provider, ChatMessage, ProviderOptions, ImageResult } from './provider.ts';
import type { ProviderConfig } from '../host/config.ts';

type FetchLike = typeof fetch;
const realFetch: FetchLike = (...args: Parameters<typeof fetch>) => fetch(...args);

/** OpenAI-compatible chat + image connector. Works with OpenAI, DeepSeek, and self-hosted gateways. */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  #baseUrl: string;
  #apiKey: string;
  #defaultModel: string;
  #fetch: FetchLike;
  constructor(id: string, config: ProviderConfig, apiKey: string, fetchImpl: FetchLike = realFetch) {
    if (!apiKey) throw new ProviderError('API key is required');
    this.id = id;
    this.#baseUrl = config.baseUrl.replace(/\/$/, '');
    this.#apiKey = apiKey;
    this.#defaultModel = config.model;
    this.#fetch = fetchImpl;
  }
  async chat(messages: readonly ChatMessage[], options: ProviderOptions = {}): Promise<string> {
    const model = options.model ?? this.#defaultModel;
    const full = options.system ? [{ role: 'system' as const, content: options.system }, ...messages] : messages;
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      signal: options.signal ?? null,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        model, messages: full, temperature: options.temperature ?? 0.8, stream: false,
      }),
    });
    if (!response.ok) throw new ProviderError(`Chat failed (${response.status})`, response.status);
    const json = await response.json() as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new ProviderError('Malformed chat response');
    return text;
  }
  async generateImage(prompt: string, options: ProviderOptions = {}): Promise<ImageResult> {
    const model = options.model ?? this.#defaultModel;
    const response = await this.#fetch(`${this.#baseUrl}/images/generations`, {
      method: 'POST',
      signal: options.signal ?? null,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json', size: '1024x1024' }),
    });
    if (!response.ok) throw new ProviderError(`Image failed (${response.status})`, response.status);
    const json = await response.json() as { data?: ({ b64_json?: string; url?: string })[] };
    const item = json.data?.[0];
    if (item?.b64_json) return { b64: item.b64_json, mime: 'image/png' };
    if (item?.url) return { url: item.url };
    throw new ProviderError('Malformed image response');
  }
}

/** DeepSeek exposes chat but no image endpoint; image generation is unsupported. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  async generateImage(): Promise<ImageResult> {
    throw new ProviderError('DeepSeek does not provide image generation');
  }
}

export function createProvider(id: string, config: ProviderConfig, apiKey: string, fetchImpl?: FetchLike): Provider {
  if (id === 'deepseek') return new DeepSeekProvider(id, config, apiKey, fetchImpl);
  return new OpenAICompatibleProvider(id, config, apiKey, fetchImpl);
}
