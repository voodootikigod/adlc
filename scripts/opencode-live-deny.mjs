#!/usr/bin/env node
// opencode-live-deny.mjs — AC7: the LIVE deny proof for the ADLC OpenCode plugin.
//
// Drives a REAL `opencode` binary end-to-end and proves the enforcement contract
// the plugin relies on: a thrown error in `tool.execute.before` aborts the tool
// call. No real model is needed — a local mock OpenAI-compatible server plays
// the model and always asks for a `write` to a frozen-rail path.
//
// Two runs, both against the same temp project:
//   1. CONTROL   (enforcement off): the write MUST land. This proves the mock
//      provider + tool loop actually executes the write — without it, a broken
//      harness would make the treatment run pass hollowly.
//   2. TREATMENT (ADLC_P4_ENFORCEMENT=1): the rail file MUST be unchanged AND
//      the tool result the model receives (captured by the mock server on the
//      follow-up request) MUST contain the rails-guard deny message.
//
// The TUI toast channel is unit-tested (test/rails-checker.test.mjs section h);
// `opencode run` is headless, so this proof asserts the deny through the two
// channels headless mode has: the aborted write and the tool-result error text.
//
// Exit codes: 0 = pass, 1 = fail, 3 = skipped (no `opencode` binary and not
// --require). CI passes --require so a missing binary can never silently skip.

import { spawn, spawnSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_INDEX = join(REPO, 'plugins', 'adlc-opencode', 'index.mjs');
const REQUIRE = process.argv.includes('--require');
const KEEP = process.argv.includes('--keep');
const RAIL_ORIGINAL = 'export const frozen = true;\n';

const log = (m) => console.log(`opencode-live-deny: ${m}`);

/** Dump the newest opencode server log from the isolated home (failure diagnosis). */
function dumpOpencodeLogs(home) {
  try {
    const logDir = join(home, '.local', 'share', 'opencode', 'log');
    if (!existsSync(logDir)) { console.error('  (no opencode log dir found)'); return; }
    const newest = readdirSync(logDir)
      .map((f) => join(logDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (newest) {
      console.error(`--- opencode log (${newest}) ---`);
      const lines = readFileSync(newest, 'utf8').split('\n');
      console.error(lines.slice(-80).join('\n'));
    }
  } catch (e) { console.error(`  (could not read opencode logs: ${e})`); }
}

let failHome = null;
const fail = (m) => {
  console.error(`opencode-live-deny: FAIL — ${m}`);
  if (failHome) dumpOpencodeLogs(failHome);
  process.exit(1);
};

// ---- preconditions ----
const which = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
if (which.error || which.status !== 0) {
  if (REQUIRE) fail('`opencode` binary not found but --require was set (install: npm i -g opencode-ai)');
  log('SKIP — no `opencode` binary on PATH (run with --require to make this fatal)');
  process.exit(3);
}
log(`opencode ${String(which.stdout || '').trim()}`);

// ---- mock OpenAI-compatible provider ----
// Every conversation: first call → tool_call write(test/x.mjs), any call whose
// messages already carry a tool result → plain "done". Tool results are
// captured per run so the treatment run can assert on the deny text the model saw.
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const chunk = (delta, finish = null) => ({
  id: 'mock-1', object: 'chat.completion.chunk', created: 1, model: 'deny-driver',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usage = () => ({
  id: 'mock-1', object: 'chat.completion.chunk', created: 1, model: 'deny-driver',
  choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});

let toolResults = []; // reset per run
const server = createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* keep {} */ }
    const messages = payload.messages ?? [];
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const results = messages.filter((m) => m.role === 'tool');
    if (KEEP) console.error(`  [mock] request: tools=${hasTools} toolResults=${results.length} roles=${messages.map((m) => m.role).join(',')}`);
    if (!hasTools) {
      // Utility calls (e.g. title generation) carry no tools — answer with text.
      sse(res, [chunk({ role: 'assistant', content: 'live deny proof' }), chunk({}, 'stop'), usage()]);
      return;
    }
    if (results.length === 0) {
      sse(res, [
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ filePath: 'test/x.mjs', content: 'OVERWRITTEN BY MODEL\n' }) } }] }),
        chunk({}, 'tool_calls'),
        usage(),
      ]);
      return;
    }
    for (const r of results) toolResults.push(typeof r.content === 'string' ? r.content : JSON.stringify(r.content));
    sse(res, [chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop'), usage()]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
log(`mock provider listening on 127.0.0.1:${PORT}`);

// ---- temp project + isolated opencode home ----
const work = mkdtempSync(join(tmpdir(), 'oc-live-deny-'));
const project = join(work, 'project');
const home = join(work, 'home');
mkdirSync(join(project, '.adlc'), { recursive: true });
mkdirSync(join(project, 'test'), { recursive: true });
mkdirSync(join(project, '.opencode', 'plugins'), { recursive: true });
mkdirSync(home, { recursive: true });
failHome = home;

writeFileSync(join(project, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', rails: ['test/**'] }] }, null, 2));
writeFileSync(join(project, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
writeFileSync(join(project, 'test', 'x.mjs'), RAIL_ORIGINAL);
// Load the real plugin from this repo via a shim (project-local plugin file).
writeFileSync(join(project, '.opencode', 'plugins', 'adlc.js'),
  `export { adlcRailsGuard } from ${JSON.stringify('file://' + PLUGIN_INDEX)};\n`);
writeFileSync(join(project, '.opencode', 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  provider: {
    mock: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Mock',
      options: { baseURL: `http://127.0.0.1:${PORT}/v1`, apiKey: 'mock' },
      models: { 'deny-driver': { name: 'deny-driver', tool_call: true } },
    },
  },
  permission: { edit: 'allow', bash: 'allow' },
}, null, 2));
try {
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project });
} catch { /* git optional — plugin falls back to directory */ }

async function runOpencode(extraEnv) {
  toolResults = [];
  // MINIMAL child env — deliberately NOT ...process.env:
  //  - a stale PWD would make opencode root the session at the CALLER's project
  //    (observed on 1.16.2), silently testing the wrong directory;
  //  - inherited *_API_KEY vars would register real providers next to the mock.
  // ASYNC spawn, not spawnSync: this script IS the mock provider's event loop —
  // a sync wait would block the HTTP server and hang every model stream.
  const child = spawn('opencode', ['run', '-m', 'mock/deny-driver', 'Overwrite test/x.mjs please'], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
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
      ...extraEnv,
    },
  });
  child.stdin.end(); // signal EOF — `opencode run` waits on piped stdin otherwise
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180_000);
  const status = await new Promise((resolveExit) => {
    child.on('close', (code) => { clearTimeout(timer); resolveExit(code); });
    child.on('error', () => { clearTimeout(timer); resolveExit(1); });
  });
  return { status, timedOut, seconds: Math.round((Date.now() - started) / 1000), stdout, stderr, toolResults: [...toolResults] };
}

let exitCode = 1;
try {
  // ---- run 1: CONTROL (enforcement off) — the write must actually land ----
  log('control run (enforcement off)…');
  const control = await runOpencode({ ADLC_P4_ENFORCEMENT: '0' });
  const afterControl = readFileSync(join(project, 'test', 'x.mjs'), 'utf8');
  if (afterControl === RAIL_ORIGINAL) {
    fail(`CONTROL run did not write the file — the harness never executed the write, so the deny proof would be hollow.\nexit=${control.status} timedOut=${control.timedOut} after ${control.seconds}s\nstdout:\n${control.stdout}\nstderr:\n${control.stderr}`);
  }
  log('control: write landed (harness genuinely executes the tool)');

  // restore the rail file for the treatment run
  writeFileSync(join(project, 'test', 'x.mjs'), RAIL_ORIGINAL);

  // ---- run 2: TREATMENT (enforcement on) — the write must be BLOCKED ----
  log('treatment run (ADLC_P4_ENFORCEMENT=1)…');
  const treatment = await runOpencode({ ADLC_P4_ENFORCEMENT: '1' });
  const afterTreatment = readFileSync(join(project, 'test', 'x.mjs'), 'utf8');
  const sawDeny = treatment.toolResults.some((t) => t.includes('ADLC rails-guard: blocked')) ||
    `${treatment.stdout}\n${treatment.stderr}`.includes('ADLC rails-guard: blocked');

  if (afterTreatment !== RAIL_ORIGINAL) {
    fail(`TREATMENT run WROTE to the frozen rail — tool.execute.before throw did NOT abort the tool.\nstdout:\n${treatment.stdout}\nstderr:\n${treatment.stderr}`);
  }
  if (!sawDeny) {
    fail(`rail file unchanged but no rails-guard deny message reached the model or the output — cannot attribute the block to the plugin.\ntool results: ${JSON.stringify(treatment.toolResults, null, 2)}\nstdout:\n${treatment.stdout}\nstderr:\n${treatment.stderr}`);
  }
  log('treatment: write blocked AND the deny reason reached the model');
  log('PASS — live deny proof holds (AC7)');
  exitCode = 0;
} finally {
  server.close();
  if (KEEP) log(`--keep: temp project retained at ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
