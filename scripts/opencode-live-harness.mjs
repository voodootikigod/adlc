// opencode-live-harness.mjs — shared setup for the LIVE OpenCode v2 proofs
// (opencode-live-deny.mjs, opencode-live-tool.mjs).
//
// What every live proof needs and must get right identically:
//   - a 2.x `opencode` binary (a v1 binary cannot load the v2 entry at all);
//   - the plugin as a USER installs it — `npm pack` tarballs of @adlc/opencode
//     and its @adlc workspace dependency closure, installed into the temp
//     project. A bare `"@adlc/opencode"` entry would make OpenCode fetch
//     `@latest` from npm into its own cache, testing the published build rather
//     than this tree; the workspace closure matters because unreleased
//     workspace packages can depend on subpaths the published ones lack;
//   - a native v2 config: `providers` (mock OpenAI-compatible endpoint),
//     ordered `permissions`, `plugins` (a package DIRECTORY — v2 rejects a
//     configured file path);
//   - `opencode run --standalone`: a private server, so the run never attaches
//     to (or is shaped by) a developer's background service;
//   - any plugin-load failure fails the proof, never a silent pass.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_PKG = '@adlc/opencode';
export const MOCK_MODEL = 'mock/driver';
/** OpenCode gives `gpt-5*` models the `patch` tool (patchText) instead of edit/write. */
export const MOCK_PATCH_MODEL = 'mock/gpt-5.2';

/** Host log lines that mean a plugin did not load (v2 wording + the v1-era banner). */
export const PLUGIN_LOAD_FAILURE = /failed to load plugin|Server plugin error|Plugin must export a default definition/;

export function makeReporter(name) {
  const log = (m) => console.log(`${name}: ${m}`);
  const fail = (m) => { console.error(`${name}: FAIL — ${m}`); process.exit(1); };
  return { log, fail };
}

/**
 * Require a 2.x `opencode` on PATH. Returns the version string, or exits 3
 * (skip) when the binary is absent and `require` is false.
 */
export function requireOpencodeV2({ log, fail, require }) {
  const which = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  if (which.error || which.status !== 0) {
    if (require) fail('`opencode` binary not found but --require was set (install a 2.x OpenCode)');
    log('SKIP — no `opencode` binary on PATH (run with --require to make this fatal)');
    process.exit(3);
  }
  const printed = String(which.stdout || '').trim();
  const version = printed.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? printed;
  if (!version.startsWith('2.')) fail(`opencode "${printed}" is not 2.x — the plugin targets the v2 plugin API only`);
  return version;
}

/** Workspace dirs keyed by package name. */
function workspacePackages() {
  const byName = new Map();
  for (const base of ['packages', 'plugins']) {
    for (const d of readdirSync(join(REPO, base))) {
      try {
        const pj = JSON.parse(readFileSync(join(REPO, base, d, 'package.json'), 'utf8'));
        byName.set(pj.name, join(REPO, base, d));
      } catch { /* not a package */ }
    }
  }
  return byName;
}

/** @adlc/opencode plus every workspace package reachable through `dependencies`. */
export function dependencyClosure(root = PLUGIN_PKG, byName = workspacePackages()) {
  const closure = new Map();
  const queue = [root];
  while (queue.length) {
    const name = queue.pop();
    if (closure.has(name) || !byName.has(name)) continue;
    closure.set(name, byName.get(name));
    const pj = JSON.parse(readFileSync(join(byName.get(name), 'package.json'), 'utf8'));
    queue.push(...Object.keys(pj.dependencies ?? {}));
  }
  return closure;
}

/** npm-pack the closure and install the tarballs into `project`. Returns the installed plugin dir. */
export function installPackedPlugin(project, packDir) {
  mkdirSync(packDir, { recursive: true });
  for (const dir of dependencyClosure().values()) {
    execFileSync('npm', ['pack', dir, '--pack-destination', packDir, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'live-proof', private: true }));
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz')).map((f) => join(packDir, f));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', ...tarballs], { cwd: project, stdio: ['ignore', 'ignore', 'inherit'] });
  return join(project, 'node_modules', ...PLUGIN_PKG.split('/'));
}

// ---- mock OpenAI-compatible provider ----
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const chunk = (delta, finish = null) => ({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'driver', choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'driver', choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } };

export const reply = {
  text: (content) => [chunk({ role: 'assistant', content }), chunk({}, 'stop'), usage],
  toolCall: (name, args) => [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
    chunk({}, 'tool_calls'),
    usage,
  ],
};

/**
 * Text of a tool-result message as the model receives it. v2 serializes a
 * failed tool call as JSON `{"error":{"message":…}}`; unwrap it so callers can
 * match the message verbatim.
 */
export function toolResultText(m) {
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === 'string') return message;
  } catch { /* plain text result */ }
  return text;
}

/**
 * Start the mock provider. `respond(payload)` returns the SSE events for one
 * /chat/completions request ({ messages, tools }).
 */
export async function startMockProvider(respond) {
  const server = createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* keep {} */ }
      sse(res, respond({ messages: payload.messages ?? [], tools: Array.isArray(payload.tools) ? payload.tools : [] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

/** Names of the tools advertised in one provider request. */
export const toolNames = (tools) => tools.map((t) => t?.function?.name ?? t?.name);

/**
 * A minimal v2 plugin that records every `permission.evaluate` dispatch to
 * `logFile` — the host-side evidence that the hook the ADLC permission lever
 * registers on is actually invoked, and with what action/resources.
 */
export function writePermissionProbe(dir, logFile) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'adlc-live-permission-probe', type: 'module', main: 'index.mjs' }));
  writeFileSync(join(dir, 'index.mjs'), `import { appendFileSync } from 'node:fs';
export default {
  id: 'adlc-live-permission-probe',
  async setup(ctx) {
    await ctx.permission.hook('evaluate', (e) => {
      appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ action: e.action, resources: e.resources, effect: e.effect }) + '\\n');
    });
  },
};
`);
  return dir;
}

/** Parsed permission.evaluate dispatches recorded by the probe. */
export function readProbe(logFile) {
  try {
    return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/**
 * Temp project with an isolated home. Writes the native v2 config. Returns
 * { work, project, home, cleanup }.
 */
export function createProject(prefix) {
  const work = mkdtempSync(join(tmpdir(), prefix));
  const project = join(work, 'project');
  const home = join(work, 'home');
  mkdirSync(join(project, '.adlc'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { work, project, home, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

export function writeConfig(project, { baseURL, plugins, permissions = [] }) {
  writeFileSync(join(project, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: MOCK_MODEL,
    providers: {
      mock: {
        name: 'Mock',
        env: ['ADLC_LIVE_MOCK_API_KEY'],
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL },
        models: { driver: { name: 'driver' }, 'gpt-5.2': { name: 'patch-driver' } },
      },
    },
    permissions,
    plugins,
  }, null, 2));
}

export function gitInit(project) {
  try {
    execFileSync('sh', ['-c', 'git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init'], { cwd: project });
  } catch { /* git optional — the plugin falls back to the directory */ }
}

/**
 * Run `opencode run --standalone` headless against the mock model.
 *
 * MINIMAL child env — deliberately NOT ...process.env: a stale PWD roots the
 * session at the caller's project, and inherited *_API_KEY vars register real
 * providers next to the mock. ASYNC spawn: this process IS the mock provider's
 * event loop, so a sync wait would hang every model stream.
 */
export async function runOpencode({ project, home, prompt, model = MOCK_MODEL, env = {}, pathPrefix = '', timeoutMs = 180_000 }) {
  const child = spawn('opencode', ['run', '--standalone', '--print-logs', '--auto', '-m', model, prompt], {
    cwd: project,
    env: {
      PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
      TERM: process.env.TERM ?? 'xterm-256color',
      LANG: process.env.LANG ?? 'C.UTF-8',
      NO_COLOR: '1',
      PWD: project,
      HOME: home,
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      ADLC_LIVE_MOCK_API_KEY: 'mock',
      ...env,
    },
  });
  child.stdin.end();
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const status = await new Promise((resolveExit) => {
    child.on('close', (code) => { clearTimeout(timer); resolveExit(code); });
    child.on('error', () => { clearTimeout(timer); resolveExit(1); });
  });
  return { status, timedOut, seconds: Math.round((Date.now() - started) / 1000), stdout, stderr };
}

/** Fail the proof when the host reports that any plugin failed to load. */
export function assertPluginsLoaded(run, fail, label) {
  const bad = run.stderr.split('\n').filter((l) => PLUGIN_LOAD_FAILURE.test(l));
  if (bad.length) fail(`${label}: a plugin failed to load:\n${bad.join('\n')}`);
}
