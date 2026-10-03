// SPDX-License-Identifier: AGPL-3.0-only
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}
export interface ProviderOptions {
  readonly model?: string;
  readonly signal?: AbortSignal | null;
  readonly temperature?: number;
  readonly system?: string | undefined;
}
export interface ImageResult {
  readonly url?: string;
  readonly b64?: string;
  readonly mime?: string;
}
export interface Provider {
  readonly id: string;
  /** Send a chat turn and return the assistant text. */
  chat(messages: readonly ChatMessage[], options?: ProviderOptions): Promise<string>;
  /** Generate an illustration. Returns a hosted URL or base64 payload. */
  generateImage(prompt: string, options?: ProviderOptions): Promise<ImageResult>;
}

export class ProviderError extends Error {
  readonly status?: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    if (status !== undefined) this.status = status;
  }
}
