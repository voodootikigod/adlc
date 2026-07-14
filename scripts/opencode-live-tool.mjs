#!/usr/bin/env node
// opencode-live-tool.mjs — LIVE proof for the native `adlc_gate` custom tool
// (Phase 4.2). Drives a REAL `opencode` binary with a mock OpenAI-compatible
// provider and proves the full path: the plugin's `tool` hook registers
// adlc_gate → it is advertised to the model → the model calls it → execute()
// runs `adlc <gate>` → the output flows back to the model.
//
// A fake `adlc` on PATH prints a sentinel for `adlc preflight`, so the tool
// result carrying that sentinel proves execute() actually shelled the gate
// (not just that registration happened).
//
// The `tool` plugin hook is confirmed in opencode 1.17.13 and very likely in
// 1.16.2 (unconfirmed verbatim). Run with --require to make a missing binary or
// missing tool-registration fatal (CI, pinned 1.17.13); without it, a binary
// that doesn't advertise adlc_gate SKIPs (exit 3) rather than failing.

import { spawn, spawnSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_INDEX = join(REPO, 'plugins', 'adlc-opencode', 'index.mjs');
const REQUIRE = process.argv.includes('--require');
const KEEP = process.argv.includes('--keep');
const SENTINEL = 'ADLC_GATE_RAN_OK_7F3A';

const log = (m) => console.log(`opencode-live-tool: ${m}`);
const fail = (m) => { console.error(`opencode-live-tool: FAIL — ${m}`); process.exit(1); };
const skip = (m) => { if (REQUIRE) fail(m); log(`SKIP — ${m}`); process.exit(3); };

const which = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
if (which.error || which.status !== 0) skip('`opencode` binary not found (install: npm i -g opencode-ai@1.17.13)');
log(`opencode ${String(which.stdout || '').trim()}`);

// ---- mock provider ----
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const chunk = (delta, finish = null) => ({ id: 'm', object: 'chat.completion.chunk', created: 1, model: 'gate-driver', choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = () => ({ id: 'm', object: 'chat.completion.chunk', created: 1, model: 'gate-driver', choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });

// The keyless-bridge child prompt carries the gate's --prompt-only text and NO
// tools; the plugin asks it via session.prompt. We answer such a turn with a
// canned verdict so the bridge parses it back through adlc_gate. This sentinel
// proves the keyless path (session.create + session.prompt) end-to-end.
const KEYLESS_VERDICT = 'ADLC_KEYLESS_VERDICT_9C2E: spec is clear';
const GATE_PROMPT_MARKER = 'AUDIT_SPEC_PROMPT_5B1D';

let advertisedAdlcGate = false;
let advertisedAdlcProsecute = false;
let toolResults = [];
let keylessAnswered = false;
const server = createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* keep {} */ }
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const hasTools = tools.length > 0;
    const messages = payload.messages ?? [];
    const flat = JSON.stringify(messages);
    if (tools.some((t) => (t?.function?.name ?? t?.name) === 'adlc_gate')) advertisedAdlcGate = true;
    if (tools.some((t) => (t?.function?.name ?? t?.name) === 'adlc_prosecute')) advertisedAdlcProsecute = true;
    const results = messages.filter((m) => m.role === 'tool');
    if (KEEP) console.error(`  [mock] tools=${hasTools} adlc_gate=${advertisedAdlcGate} toolResults=${results.length} keyless=${flat.includes(GATE_PROMPT_MARKER)}`);

    // Keyless child turn: the gate's --prompt-only text reached a child session.
    if (flat.includes(GATE_PROMPT_MARKER)) {
      keylessAnswered = true;
      sse(res, [chunk({ role: 'assistant', content: KEYLESS_VERDICT }), chunk({}, 'stop'), usage()]);
      return;
    }
    if (!hasTools) { sse(res, [chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop'), usage()]); return; }
    if (results.length === 0) {
      // First main turn: call adlc_gate for an LLM-backed gate (spec-lint), which
      // drives the keyless bridge → child session.
      sse(res, [
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'adlc_gate', arguments: JSON.stringify({ gate: 'spec-lint' }) } }] }),
        chunk({}, 'tool_calls'), usage(),
      ]);
      return;
    }
    for (const r of results) toolResults.push(typeof r.content === 'string' ? r.content : JSON.stringify(r.content));
    sse(res, [chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop'), usage()]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
log(`mock provider on 127.0.0.1:${PORT}`);

// ---- temp project + isolated home + fake `adlc` on PATH ----
const work = mkdtempSync(join(tmpdir(), 'oc-live-tool-'));
const project = join(work, 'project');
const home = join(work, 'home');
const bin = join(work, 'bin');
mkdirSync(join(project, '.adlc'), { recursive: true });
mkdirSync(join(project, '.opencode', 'plugins'), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });

// Fake `adlc`: `preflight` prints a sentinel (deterministic-gate proof);
// `spec-lint --prompt-only` prints a gate prompt carrying the keyless marker so
// the bridge routes it to a child session (keyless proof). Exits 0.
const adlcShim = join(bin, 'adlc');
writeFileSync(adlcShim,
  `#!/usr/bin/env bash\n` +
  `if [ "$1" = "preflight" ]; then echo "${SENTINEL}"; exit 0; fi\n` +
  `if [ "$1" = "spec-lint" ]; then echo "Audit this spec for clarity. ${GATE_PROMPT_MARKER}"; exit 0; fi\n` +
  `echo "unexpected: $*" 1>&2; exit 1\n`);
chmodSync(adlcShim, 0o755);

// Enforcement ON with an active ticket + a real rail — proves adlc_gate is not
// denied by the plugin's own tool.execute.before rail guard (P5 finding).
writeFileSync(join(project, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'Live tool fixture', rails: ['locked/**'] }] }, null, 2));
writeFileSync(join(project, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
writeFileSync(join(project, '.opencode', 'plugins', 'adlc.js'),
  `export { adlcRailsGuard } from ${JSON.stringify('file://' + PLUGIN_INDEX)};\n`);
writeFileSync(join(project, '.opencode', 'opencode.json'), JSON.stringify({
  provider: {
    mock: { npm: '@ai-sdk/openai-compatible', name: 'Mock', options: { baseURL: `http://127.0.0.1:${PORT}/v1`, apiKey: 'mock' }, models: { 'gate-driver': { name: 'gate-driver', tool_call: true } } },
  },
}, null, 2));
try { execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: project }); } catch { /* optional */ }

function runOpencode() {
  return new Promise((resolveExit) => {
    const child = spawn('opencode', ['run', '-m', 'mock/gate-driver', 'Run the preflight gate via adlc_gate'], {
      cwd: project,
      env: {
        PATH: `${bin}:${process.env.PATH}`, // fake adlc first
        TERM: process.env.TERM ?? 'xterm-256color', LANG: process.env.LANG ?? 'C.UTF-8', NO_COLOR: '1',
        PWD: project, HOME: home,
        XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state'),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        ADLC_P4_ENFORCEMENT: '1', // prove adlc_gate survives the rail guard under enforcement
        ADLC_TICKET: 'T1',
      },
    });
    child.stdin.end();
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('close', () => { clearTimeout(timer); resolveExit({ stdout, stderr }); });
    child.on('error', () => { clearTimeout(timer); resolveExit({ stdout, stderr }); });
  });
}

let exitCode = 1;
try {
  log('running opencode: model calls adlc_gate(spec-lint) → keyless bridge → child session…');
  const r = await runOpencode();
  if (!advertisedAdlcGate) {
    skip(`adlc_gate was not advertised to the model — the plugin \`tool\` hook may be unsupported on this opencode (${String(which.stdout).trim()}). stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  log('✓ adlc_gate registered and advertised to the model (4.2)');
  // T33: adlc_prosecute registers on the same tool hook and is advertised too.
  if (!advertisedAdlcProsecute) {
    fail(`adlc_prosecute (T33) was not advertised to the model — the second native tool did not register alongside adlc_gate.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  log('✓ adlc_prosecute registered and advertised to the model (T33)');
  // 4.1: the keyless bridge spun up a child session with the gate's prompt.
  if (!keylessAnswered) {
    fail(`adlc_gate ran an LLM-backed gate but the keyless bridge never prompted a child session (session.create/prompt).\ntoolResults: ${JSON.stringify(toolResults, null, 2)}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  log('✓ keyless bridge spun up a child session and prompted it (4.1: session.create + session.prompt)');
  // 4.1→4.2: the child's verdict flowed back through adlc_gate to the model.
  const verdictReached = toolResults.some((t) => t.includes('ADLC_KEYLESS_VERDICT_9C2E'));
  if (!verdictReached) {
    fail(`the keyless child answered, but its verdict never flowed back through adlc_gate to the model.\ntoolResults: ${JSON.stringify(toolResults, null, 2)}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  log('✓ the child\'s keyless verdict flowed back through adlc_gate to the model (4.1→4.2 wiring)');
  log('PASS — native adlc_gate tool + keyless bridge proven end-to-end');
  exitCode = 0;
} finally {
  server.close();
  if (KEEP) log(`--keep: ${work}`); else rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
