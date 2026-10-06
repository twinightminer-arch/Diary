// SPDX-License-Identifier: AGPL-3.0-only
// Plugin loader for the AI access layer.
//
// Drop a .mjs file into <userData>/plugins/ and it becomes a first-class AI
// backend inside Diary: it shows up in 设置 → AI, it can be selected as the
// active provider, and it can either reuse the built-in OpenAI-compatible
// transport (just declare baseUrl + model) or implement `chat()` itself to talk
// to a local CLI, a bespoke gateway, or any non-OpenAI protocol.
import { readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatMessage, ImageResult, ProviderOptions } from '../agent/provider.ts';

export type ProviderPluginChatInput = {
  readonly messages: readonly ChatMessage[];
  readonly system?: string | undefined;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
};
export type ProviderPluginImageInput = { readonly prompt: string; readonly model: string; readonly apiKey: string; readonly baseUrl: string; readonly fetch: typeof fetch };

export type ProviderPlugin = {
  readonly id: string;
  readonly label?: string;
  /** Defaults written into the config the first time the plugin is seen. */
  readonly baseUrl?: string;
  readonly model?: string;
  /** Custom transport. When omitted the built-in OpenAI-compatible client is used. */
  readonly chat?: (input: ProviderPluginChatInput) => Promise<string> | string;
  readonly generateImage?: (input: ProviderPluginImageInput) => Promise<ImageResult> | ImageResult;
};

export type DiaryPlugin = {
  readonly id?: string;
  readonly name?: string;
  readonly provider?: ProviderPlugin;
  readonly providers?: readonly ProviderPlugin[];
};

export type PluginError = { file: string; message: string };
export type PluginSource = { file: string; id: string; label: string; baseUrl: string; model: string; custom: boolean };
export type LoadedPlugins = { providers: ProviderPlugin[]; sources: PluginSource[]; errors: PluginError[]; directory: string };

const TEMPLATE = `// Diary AI plugin — every file here is loaded at startup.
// Rename this file to something.mjs and restart Diary to activate it.
//
// 1) Reuse the built-in OpenAI-compatible transport: just declare baseUrl + model.
export default {
  id: 'my-gateway',
  label: '我的自建网关',
  provider: {
    id: 'my-gateway',
    label: '我的自建网关',
    baseUrl: 'https://example.com/v1',
    model: 'my-model',
  },
};

// 2) Or take full control of the transport (the plugin owns the request):
//
// export default {
//   id: 'my-cli',
//   provider: {
//     id: 'my-cli',
//     label: '本地 CLI',
//     model: 'local',
//     async chat({ messages, system }) {
//       const prompt = [system, ...messages.map(m => m.content)].filter(Boolean).join('\\n');
//       const { execFile } = await import('node:child_process');
//       const { promisify } = await import('node:util');
//       const run = promisify(execFile);
//       const { stdout } = await run('my-cli', ['chat', prompt], { maxBuffer: 10 * 1024 * 1024 });
//       return stdout.trim();
//     },
//   },
// };
`;

// Ships with the app: turns the WorkBuddy (CodeBuddy) CLI on this machine into a
// selectable AI backend, so Diary can answer through the same account the user
// already signed into WorkBuddy with — no third-party API key required.
//
// Written out as a real .mjs on first run rather than kept inside the bundle, so
// the user can read it, edit the model, or delete it. Two things in here are
// load-bearing and were found the hard way:
//   1. `SERVER__PORT` must be removed from the child environment. WorkBuddy
//      injects it into every child process, and a standalone CLI reads it and
//      tries to bind that same port. It collides with the running sidecar,
//      throws EADDRINUSE, and then **never exits** — Diary just spins forever.
//   2. The CLI authenticates on its own. If it has never been logged in, it
//      prints "Authentication required." and we surface that as a plain
//      instruction instead of a stack trace.
const WORKBUDDY_PLUGIN = `// Diary AI 插件 —— 连接本机 WorkBuddy（CodeBuddy CLI）
//
// 把 WorkBuddy 桌面版自带的 codebuddy CLI 当成一个模型后端来用：
//     codebuddy -p "<prompt>" --tools ""
// 只取标准输出作为回答，所以不会进入交互式界面。
//
// 两个踩过的坑，改之前请先读懂：
//  1) 调用前必须删掉环境变量 SERVER__PORT。WorkBuddy 会把它注入所有子进程，
//     而独立启动的 CLI 会拿它去 bind 同一个端口，撞上正在运行的 sidecar 之后
//     报 EADDRINUSE 并永远不退出 —— 在 Diary 里表现为一直转圈。
//  2) CLI 需要自己登录一次。没登录时它会输出 "Authentication required."，
//     本插件会把它翻译成一句人话。
//
// 想换模型：改下面的 model，可选 hy3 / hy3-x / deepseek-v4.1-flash /
// glm-5.3 / kimi-k3-1 等（以 codebuddy --model 支持的为准）。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// WorkBuddy 会话注入给子进程的变量，独立跑 CLI 时必须剔除。
const SESSION_VARS = [
  'SERVER__PORT', 'SERVER__HOST',
  'CODEBUDDY_SERVICE_PROXY_URL', 'CODEBUDDY_SESSION_ID',
  'CODEBUDDY_CONVERSATION_MESSAGE_ID', 'CODEBUDDY_CONVERSATION_REQUEST_ID',
  'CODEBUDDY_HOST_CAPABILITIES', 'CODEBUDDY_GATEWAY_AUTH',
  'CODEBUDDY_GATEWAY_PASSWORD', 'CODEBUDDY_SAFE_DELETE_SANDBOX',
  'CODEBUDDY_SAFE_DELETE_BIN_DIR', 'CODEBUDDY_SAFE_DELETE_REPORT_PATH',
  'CODEBUDDY_SAFE_DELETE_BULK_GUARD', 'CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD',
  'CODEBUDDY_PROJECT_DIR', 'CODEBUDDY_INCLUDE_TOPIC_MESSAGE',
];

function cliScript() {
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || '';
  const list = [];
  if (process.env.DIARY_WORKBUDDY_CLI) list.push(process.env.DIARY_WORKBUDDY_CLI);
  if (local) {
    list.push(join(local, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
    list.push(join(local, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  }
  if (programFiles) list.push(join(programFiles, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  for (const candidate of list) { if (candidate && existsSync(candidate)) return candidate; }
  return null;
}

function nodeBinaries() {
  const list = [];
  if (process.env.CODEBUDDY_NODE_BIN && existsSync(process.env.CODEBUDDY_NODE_BIN)) list.push(process.env.CODEBUDDY_NODE_BIN);
  const programFiles = process.env.ProgramFiles || '';
  if (programFiles) {
    const system = join(programFiles, 'nodejs', 'node.exe');
    if (existsSync(system)) list.push(system);
  }
  return list;
}

function runOnce(command, args, env, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(command, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: env,
    }, function (error, stdout, stderr) {
      resolve({ error: error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function ask(prompt, options) {
  const script = cliScript();
  if (!script) {
    throw new Error('没找到 WorkBuddy 的 codebuddy CLI。请确认已安装 WorkBuddy 桌面版；'
      + '如果装在别处，可以设置环境变量 DIARY_WORKBUDDY_CLI 指向它。');
  }

  const env = Object.assign({}, process.env);
  for (const key of SESSION_VARS) delete env[key];
  if (options.apiKey) env.CODEBUDDY_API_KEY = options.apiKey;
  else delete env.CODEBUDDY_API_KEY;

  const args = ['-p', prompt, '--tools', ''];
  if (options.model) args.push('--model', options.model);

  // codebuddy 是带 shebang 的 CommonJS 脚本且没有扩展名，Windows 不能直接执行，
  // 必须交给一个 node 运行时：先试独立 node，再试把 Electron 自己当 node 用。
  const attempts = nodeBinaries().map(function (bin) {
    return { command: bin, env: env };
  });
  attempts.push({
    command: process.execPath,
    env: Object.assign({}, env, { ELECTRON_RUN_AS_NODE: '1' }),
  });

  let lastStderr = '';
  for (const attempt of attempts) {
    const result = await runOnce(attempt.command, [script].concat(args), attempt.env, options.timeoutMs);
    const combined = result.stdout + result.stderr;
    if (/Authentication required/i.test(combined)) {
      throw new Error('WorkBuddy CLI 还没登录。请在终端里运行一次 codebuddy 并输入 /login 完成登录；'
        + '或者把 WorkBuddy 的 API Key 填进设置 → AI 的「API Key」里。');
    }
    const text = result.stdout.trim();
    if (text) return text;
    lastStderr = result.stderr.trim() || (result.error ? result.error.message : '');
  }
  throw new Error('调用 WorkBuddy CLI 没有得到回复。' + (lastStderr ? '（' + lastStderr.slice(0, 300) + '）' : ''));
}

export default {
  id: 'workbuddy',
  name: 'WorkBuddy 本机 CLI',
  provider: {
    id: 'workbuddy',
    label: 'WorkBuddy（本机 AI）',
    model: 'hy3',
    async chat(input) {
      const parts = [];
      if (input.system) parts.push(input.system);
      for (const message of input.messages) {
        const role = message.role === 'assistant' ? '助手：' : message.role === 'user' ? '用户：' : '';
        parts.push(role + message.content);
      }
      return await ask(parts.join('\\n\\n'), {
        model: input.model || 'hy3',
        apiKey: input.apiKey,
        timeoutMs: 180000,
      });
    },
  },
};
`;

/** Creates the plugins directory with the shipped plugins the first time it is needed. */
export async function ensurePluginDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const readme = join(directory, 'README-plugins.md');
  try { await access(readme); } catch { await writeFile(readme, TEMPLATE, 'utf8'); }
  // Written once, then owned by the user: never overwrite an existing file, so
  // edits to the model name (or deleting it outright) survive restarts.
  const builtin = join(directory, 'workbuddy.mjs');
  try { await access(builtin); } catch { await writeFile(builtin, WORKBUDDY_PLUGIN, 'utf8'); }
}

/** Loads every .mjs/.js file in the directory. A broken plugin never blocks startup. */
export async function loadPlugins(directory: string): Promise<LoadedPlugins> {
  const providers: ProviderPlugin[] = [];
  const sources: PluginSource[] = [];
  const errors: PluginError[] = [];
  let files: string[] = [];
  try {
    await ensurePluginDirectory(directory);
    files = (await readdir(directory)).filter(name => name.endsWith('.mjs') || name.endsWith('.js'));
  } catch (error) {
    return { providers, sources, errors: [{ file: directory, message: error instanceof Error ? error.message : String(error) }], directory };
  }
  for (const file of files) {
    try {
      const module = await import(pathToFileURL(join(directory, file)).href) as { default?: DiaryPlugin } & DiaryPlugin;
      const plugin = (module.default ?? module) as DiaryPlugin;
      const list = plugin.providers ?? (plugin.provider ? [plugin.provider] : []);
      if (!list.length) { errors.push({ file, message: '插件没有导出 provider' }); continue; }
      for (const provider of list) {
        if (typeof provider?.id !== 'string' || !provider.id.trim()) { errors.push({ file, message: 'provider.id 必须是字符串' }); continue; }
        providers.push(provider);
        sources.push({
          file: join(directory, file),
          id: provider.id,
          label: provider.label ?? plugin.name ?? provider.id,
          baseUrl: provider.baseUrl ?? '',
          model: provider.model ?? '',
          custom: typeof provider.chat === 'function',
        });
      }
    } catch (error) {
      errors.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { providers, sources, errors, directory };
}

/** True when a plugin can answer without any API key (local gateway, CLI, …). */
export function providerNeedsKey(provider: ProviderPlugin | undefined): boolean {
  return typeof provider?.chat !== 'function';
}

export type { ChatMessage, ImageResult, ProviderOptions };
