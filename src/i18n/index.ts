// SPDX-License-Identifier: AGPL-3.0-only
import { dictionaries } from './dictionaries.ts';
import type { Locale, MessageKey } from './dictionaries.ts';
export { dictionaries };
export type { Locale, MessageKey };

export function resolveLocale(value: string): Locale {
  const tag = value.replaceAll('_', '-').toLowerCase();
  if (tag === 'zh' || tag.startsWith('zh-')) {
    return /(?:^|-)(tw|hk|mo|hant)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh-CN';
  }
  if (/^ja(?:-|$)/.test(tag)) return 'ja-JP';
  if (/^ko(?:-|$)/.test(tag)) return 'ko-KR';
  return 'en-US';
}

export class LocaleManager {
  #locale: Locale;
  #listeners = new Set<(locale: Locale) => void>();
  constructor(locale = 'en-US') { this.#locale = resolveLocale(locale); }
  get locale(): Locale { return this.#locale; }
  setLocale(value: string): void {
    const next = resolveLocale(value);
    if (next === this.#locale) return;
    this.#locale = next;
    for (const listener of [...this.#listeners]) listener(next);
  }
  subscribe(listener: (locale: Locale) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  t(key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
    return dictionaries[this.#locale][key].replace(/\{(\w+)\}/g, (token, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : token);
  }
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(this.#locale, options).format(value);
  }
  number(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.#locale, options).format(value);
  }
}
