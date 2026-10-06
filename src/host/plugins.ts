// SPDX-License-Identifier: AGPL-3.0-only
// Plugin loader for the AI access layer.
//
// Drop a .mjs file into <userData>/plugins/ and it becomes a first-class AI
// backend inside Diary: it shows up in the sidebar's AI 模型 screen, it can be selected as the
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
  /**
   * Every model this backend can serve, written as `<vendor>/<model>` so the
   * same name never means two things on screen. Shown as the picker's
   * suggestions; the first entry is the default.
   */
  readonly models?: readonly string[];
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
/** A loaded plugin as the UI sees it. `enabled` is the user's on/off switch. */
export type PluginSource = {
  file: string; id: string; label: string; baseUrl: string; model: string;
  custom: boolean; models: string[]; enabled: boolean;
};
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
//   2. The CLI keeps its own login, so a bare `codebuddy -p` answers with
//      "Authentication required." The fix is to reuse the desktop app's own
//      session instead of asking for a second login: WorkBuddy holds a
//      Keycloak access token in memory (nothing usable is ever written to
//      disk), so the plugin lifts it out of the running process with the
//      shipped `workbuddy-token.py` and hands it to the CLI as
//      `CODEBUDDY_AUTH_TOKEN` — the CLI's documented bring-your-own-token
//      entry point.
const WORKBUDDY_PLUGIN = `// Diary AI 插件 —— 连接本机 WorkBuddy（免登录）
//
// 把 WorkBuddy 桌面版自带的 codebuddy CLI 当成一个模型后端来用：
//     codebuddy -p "<prompt>" --tools ""
// 只取标准输出作为回答，所以不会进入交互式界面。
//
// 认证是全自动的，不需要 /login，也不需要填 API Key：
//   WorkBuddy 桌面版把自己的登录令牌只放在内存里（磁盘上找不到可用的），
//   所以本插件用同目录的 workbuddy-token.py 从正在运行的 WorkBuddy 进程里
//   把它读出来，再通过环境变量 CODEBUDDY_AUTH_TOKEN 交给 CLI。
//   前提是 WorkBuddy 桌面版开着并且已经登录（本来就是这个后端的使用条件）。
//
// 两个踩过的坑，改之前请先读懂：
//  1) 调用前必须删掉环境变量 SERVER__PORT。WorkBuddy 会把它注入所有子进程，
//     而独立启动的 CLI 会拿它去 bind 同一个端口，撞上正在运行的 sidecar 之后
//     报 EADDRINUSE 并永远不退出 —— 在 Diary 里表现为一直转圈。
//  2) 令牌会过期，所以要带过期时间缓存；过期了就重新读一次内存。
//     读内存需要一个 Python 解释器，WorkBuddy 自带的那个优先。
//
// 想换模型：改下面 MODELS 里的任意一项，或把默认那一项挪到第一位。
// 写法统一为 workbuddy/<型号>，和界面上显示的名字一模一样；workbuddy/ 前缀
// 只是给 Diary 看的名字空间，真正传给 codebuddy --model 时会剥掉。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// 可选模型（以 codebuddy --model 实际支持的为准）。第一个是默认值。
const MODELS = [
  'workbuddy/hy3',
  'workbuddy/hy3-x',
  'workbuddy/deepseek-v4.1-flash',
  'workbuddy/glm-5.3',
  'workbuddy/kimi-k3-1',
];
const DEFAULT_MODEL = MODELS[0];
const NS = 'workbuddy/';
// Diary 里存的是 workbuddy/xxx，CLI 只认 xxx。
function cliModel(model) {
  const raw = String(model || DEFAULT_MODEL).trim();
  return raw.startsWith(NS) ? raw.slice(NS.length) : raw;
}

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

// ---- 登录令牌 -----------------------------------------------------------
// WorkBuddy 把登录令牌只放在内存里，所以要用 workbuddy-token.py 现场读一次。
// 令牌自带过期时间（exp），缓存下来，避免每问一句都去扫一遍进程内存。

function tokenScript(extension) {
  const list = [];
  const override = process.env.DIARY_WORKBUDDY_TOKEN_SCRIPT;
  if (override && override.endsWith(extension)) list.push(override);
  // Diary ships both a Python and a PowerShell flavour of the helper and uses
  // whichever runtime this machine actually has.
  const name = 'workbuddy-token' + extension;
  if (typeof process.resourcesPath === 'string') list.push(join(process.resourcesPath, name));
  list.push(join(dirname(process.execPath), 'resources', name));
  for (const candidate of list) { if (candidate && existsSync(candidate)) return candidate; }
  return null;
}

function pythonBinaries() {
  const list = [];
  if (process.env.DIARY_WORKBUDDY_PY && existsSync(process.env.DIARY_WORKBUDDY_PY)) list.push(process.env.DIARY_WORKBUDDY_PY);
  // WorkBuddy 自带一个 Python：装了 WorkBuddy 就一定有它，优先用。
  const bundled = join(homedir(), '.workbuddy', 'binaries', 'python', 'versions');
  try {
    for (const version of readdirSync(bundled).sort().reverse()) {
      const exe = join(bundled, version, 'python.exe');
      if (existsSync(exe)) list.push(exe);
    }
  } catch { }
  const local = process.env.LOCALAPPDATA || '';
  if (local) {
    const programs = join(local, 'Programs', 'Python');
    try {
      for (const folder of readdirSync(programs).sort().reverse()) {
        const exe = join(programs, folder, 'python.exe');
        if (existsSync(exe)) list.push(exe);
      }
    } catch { }
  }
  list.push('python.exe', 'python', 'python3');
  return list;
}

function powershellBinaries() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\\\Windows';
  return [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh.exe',
    'powershell.exe',
  ];
}

function tokenCachePath() {
  return join(process.env.LOCALAPPDATA || tmpdir(), 'Diary', 'workbuddy-token.json');
}

function readTokenCache() {
  try {
    const data = JSON.parse(readFileSync(tokenCachePath(), 'utf8'));
    if (data && typeof data.token === 'string' && typeof data.exp === 'number') return data;
  } catch { }
  return null;
}

function writeTokenCache(record) {
  try {
    const file = tokenCachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record), 'utf8');
  } catch { }
}

function runCapture(command, args, env, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(command, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: env,
    }, function (error, stdout, stderr) {
      resolve({ error: error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// 跑一次提取脚本，把最后一行 JSON 解析出来。
async function probeToken(command, args, env) {
  const result = await runCapture(command, args, env, 120000);
  const lines = (result.stdout || '').trim().split('\\n');
  const text = (lines[lines.length - 1] || '').trim();
  if (!text) {
    const reason = (result.stderr || '').trim() || (result.error ? result.error.message : '');
    return { ok: false, reason: reason, retry: true };
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: text.slice(0, 200), retry: true }; }
  if (parsed && parsed.ok && parsed.token) return parsed;
  const reason = (parsed && parsed.reason) || '未知错误';
  // 解释器本身没问题，只是 WorkBuddy 没开着：再换解释器也一样，直接放弃。
  return { ok: false, reason: reason, retry: !/not running/i.test(reason) };
}

async function discoverToken() {
  const env = Object.assign({}, process.env);
  for (const key of SESSION_VARS) delete env[key];
  let last = '';
  const python = tokenScript('.py');
  if (python) {
    for (const bin of pythonBinaries()) {
      const outcome = await probeToken(bin, [python], env);
      if (outcome.ok) return outcome;
      last = outcome.reason || last;
      if (!outcome.retry) break;
    }
  }
  const powershell = tokenScript('.ps1');
  if (powershell) {
    for (const bin of powershellBinaries()) {
      const outcome = await probeToken(bin, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', powershell], env);
      if (outcome.ok) return outcome;
      last = outcome.reason || last;
      if (!outcome.retry) break;
    }
  }
  if (!python && !powershell) last = '没找到 workbuddy-token.py / .ps1';
  throw new Error('没能自动取得 WorkBuddy 的登录令牌（' + (last || '原因未知')
    + '）。请确认 WorkBuddy 桌面版已经打开并且处于登录状态。');
}

async function sessionToken() {
  const cached = readTokenCache();
  // 留 5 分钟余量，免得刚好卡在过期边界上。
  if (cached && cached.exp * 1000 - Date.now() > 5 * 60 * 1000) return cached.token;
  const fresh = await discoverToken();
  writeTokenCache({ token: fresh.token, exp: fresh.exp });
  return fresh.token;
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

// 认证令牌：优先用设置里手填的那一个，否则自动从 WorkBuddy 桌面版读。
async function pickToken(options, force) {
  if (options.apiKey) return options.apiKey;
  if (!force) return await sessionToken();
  // 缓存里的令牌被服务端拒了：丢掉重读一次内存，通常立刻就好。
  writeTokenCache({ token: '', exp: 0 });
  const fresh = await discoverToken();
  writeTokenCache({ token: fresh.token, exp: fresh.exp });
  return fresh.token;
}

async function runCli(prompt, options, token) {
  const script = cliScript();
  if (!script) {
    throw new Error('没找到 WorkBuddy 的 codebuddy CLI。请确认已安装 WorkBuddy 桌面版；'
      + '如果装在别处，可以设置环境变量 DIARY_WORKBUDDY_CLI 指向它。');
  }

  const env = Object.assign({}, process.env);
  for (const key of SESSION_VARS) delete env[key];
  // 令牌只走 CODEBUDDY_AUTH_TOKEN 这一个入口，免得旧的 API Key 变量把它盖掉。
  delete env.CODEBUDDY_API_KEY;
  env.CODEBUDDY_AUTH_TOKEN = token;

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
      const error = new Error('WorkBuddy 的登录令牌被拒绝了。请打开 WorkBuddy 桌面版确认已登录，然后重试。');
      error.code = 'AUTH';
      throw error;
    }
    const text = result.stdout.trim();
    if (text) return text;
    lastStderr = result.stderr.trim() || (result.error ? result.error.message : '');
  }
  throw new Error('调用 WorkBuddy CLI 没有得到回复。' + (lastStderr ? '（' + lastStderr.slice(0, 300) + '）' : ''));
}

async function ask(prompt, options) {
  try {
    return await runCli(prompt, options, await pickToken(options, false));
  } catch (error) {
    if (error && error.code === 'AUTH' && !options.apiKey) {
      // 令牌刚好过期是常态，不是故障：静默重读一次再试。
      return await runCli(prompt, options, await pickToken(options, true));
    }
    throw error;
  }
}

export default {
  id: 'workbuddy',
  name: 'WorkBuddy 本机 CLI',
  provider: {
    id: 'workbuddy',
    label: 'WorkBuddy（本机 AI）',
    model: DEFAULT_MODEL,
    models: MODELS,
    async chat(input) {
      const parts = [];
      if (input.system) parts.push(input.system);
      for (const message of input.messages) {
        const role = message.role === 'assistant' ? '助手：' : message.role === 'user' ? '用户：' : '';
        parts.push(role + message.content);
      }
      return await ask(parts.join('\\n\\n'), {
        model: cliModel(input.model),
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
export async function loadPlugins(directory: string, isEnabled?: (id: string) => boolean): Promise<LoadedPlugins> {
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
          models: [...(provider.models ?? [])],
          enabled: isEnabled ? isEnabled(provider.id) : true,
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
