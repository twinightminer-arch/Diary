// SPDX-License-Identifier: AGPL-3.0-only
import { SkillEngine, type Capability, type CapabilityHandler } from '../plugins/skill-engine.ts';
import { createProvider } from './connectors.ts';
import type { Provider } from './provider.ts';
import type { HostConfig } from '../host/config.ts';
import { getWeather, reverseGeocode, today, webSearch } from './web.ts';
import { importMedia, readMediaDataUrl } from '../host/media.ts';

const DIARY_SYSTEM = '你是一位温柔、克制的日记助手。帮助用户把一天的心情、事件与想法整理成真诚、自然的日记文字；' +
  '不编造未提供的细节，不替用户下判断。输出使用简体中文，保持 Markdown 格式。';

async function decodeImage(result: { url?: string; b64?: string; mime?: string }, fetchImpl: typeof fetch): Promise<{ data: Uint8Array; mime: string }> {
  if (result.b64) return { data: Uint8Array.from(Buffer.from(result.b64, 'base64')), mime: result.mime ?? 'image/png' };
  if (result.url) {
    const response = await fetchImpl(result.url);
    if (!response.ok) throw new Error(`Failed to fetch generated image (${response.status})`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { data: buffer, mime: response.headers.get('content-type') ?? 'image/png' };
  }
  throw new Error('Image generation returned no payload');
}

export interface AgentOptions { vault: string; config: HostConfig; fetchImpl?: typeof fetch }
export interface ComposeInput {
  task?: 'compose' | 'polish' | 'continue' | 'title' | 'illustrate-prompt';
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  system?: string;
}
export interface WebInput {
  kind: 'date' | 'weather' | 'geocode' | 'search';
  lat?: number; lon?: number; locale?: string; query?: string;
}
export interface LayoutInput { markdown: string; template: 'journal' | 'letter' | 'bullets' | 'none' }

function applyLayout(input: LayoutInput): string {
  const body = input.markdown.trim();
  if (input.template === 'none' || !body) return body;
  if (input.template === 'bullets') {
    return body.split(/\r?\n+/).filter(Boolean).map(line => `- ${line}`).join('\n');
  }
  if (input.template === 'letter') {
    return `亲爱的自己：\n\n${body}\n\n—— 写于此刻`;
  }
  // journal: ensure a leading date line and a mood line placeholder.
  const date = today('zh-CN').iso;
  return `# ${date}\n\n${body}`;
}

/**
 * Builds the diary agent: a SkillEngine whose capability handlers talk to the configured
 * provider / web services / media store. Third-party trusted skills request these capabilities;
 * the host (desktop or Android) performs the work and never exposes secrets to the web layer.
 */
export function buildAgent(options: AgentOptions): { engine: SkillEngine; api: AgentApi } {
  const { vault, config, fetchImpl = fetch } = options;
  const provider = async (): Promise<Provider> => {
    const id = config.activeProvider;
    const key = await config.getSecret(id);
    if (!key) throw new Error(`未配置提供方 "${id}" 的 API Key`);
    return createProvider(id, config.getProvider(id), key, fetchImpl);
  };
  const handlers: Partial<Record<Capability, CapabilityHandler>> = {
    'agent:invoke': async (input) => {
      const { task, messages, system } = input as ComposeInput;
      const providerInstance = await provider();
      const sys = system ?? (task === 'polish' ? '请润色并优化以下日记，保持原意与语气：'
        : task === 'title' ? '为这篇日记起一个简短、贴切的标题（只返回标题）：'
        : task === 'illustrate-prompt' ? '用一句话描述适合这篇日记的插画画面（只返回画面描述）：'
        : DIARY_SYSTEM);
      return providerInstance.chat(messages, { system });
    },
    'media:generate': async (input) => {
      const { prompt } = input as { prompt: string };
      const providerInstance = await provider();
      const image = await providerInstance.generateImage(prompt);
      const { data, mime } = await decodeImage(image, fetchImpl);
      const info = await importMedia(vault, data, 'illustration', mime);
      return { id: info.id, mime: info.mime, dataUrl: await readMediaDataUrl(vault, info.id) };
    },
    'web:search': async (input) => {
      const req = input as WebInput;
      if (req.kind === 'date') return today(req.locale ?? 'zh-CN');
      if (req.kind === 'weather') {
        if (typeof req.lat !== 'number' || typeof req.lon !== 'number') throw new Error('Weather needs lat/lon');
        return getWeather(req.lat, req.lon, fetchImpl);
      }
      if (req.kind === 'geocode') {
        if (typeof req.lat !== 'number' || typeof req.lon !== 'number') throw new Error('Geocode needs lat/lon');
        return reverseGeocode(req.lat, req.lon, fetchImpl);
      }
      return webSearch(req.query ?? '', async (prompt) => (await provider()).chat([{ role: 'user', content: prompt }]));
    },
    'layout:apply': async (input) => applyLayout(input as LayoutInput),
  };
  const engine = new SkillEngine(handlers);
  // Host meta-skills forward to a single granted capability.
  for (const [name, capability] of [['host.agent', 'agent:invoke'], ['host.media', 'media:generate'], ['host.web', 'web:search'], ['host.layout', 'layout:apply']] as const) {
    engine.load({
      definition: { id: name, description: name, instructions: name, capabilities: [capability] },
      run: (input, ctx) => ctx.call(capability, input),
    }, [capability]);
  }
  const api: AgentApi = {
    compose: (input: ComposeInput) => engine.execute('host.agent', input),
    illustrate: (prompt: string) => engine.execute('host.media', { prompt }),
    web: (input: WebInput) => engine.execute('host.web', input),
    layout: (input: LayoutInput) => engine.execute('host.layout', input),
  };
  return { engine, api };
}

export interface AgentApi {
  compose(input: ComposeInput): Promise<unknown>;
  illustrate(prompt: string): Promise<unknown>;
  web(input: WebInput): Promise<unknown>;
  layout(input: LayoutInput): Promise<unknown>;
}
