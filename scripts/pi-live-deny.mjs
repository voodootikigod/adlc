#!/usr/bin/env node
// pi-live-deny.mjs — live proof that the adlc-pi extension denies a frozen-rail
// write inside a real pi agent loop (ADR-0004-style AC: the deny path must be
// exercised through the harness, not only through unit-called handlers).
//
// Builds a temp git repo with an active ADLC ticket whose rails freeze
// test/contracts/**, launches `pi --mode rpc` with (a) the adlc-pi extension
// and (b) a scripted stub provider whose model's first turn tool-calls
// `write` against the rail file. Asserts the tool call is denied and the rail
// file is byte-identical afterwards. No network, no API keys: the stub
// provider fabricates the assistant messages in-process.
//
// RPC framing note: strict JSONL with LF delimiters — Node readline is
// documented non-compliant (splits on U+2028/U+2029), so stdout is split
// manually on \n.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piBin = join(repoRoot, 'node_modules', '.bin', 'pi');
const adlcExtension = join(repoRoot, 'plugins', 'adlc-pi', 'index.ts');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.log(`SKIP: pi requires Node >= 22.19 (running ${process.version}). ` +
    'CI runs this proof on the Node 22 matrix leg.');
  process.exit(0);
}
if (!existsSync(piBin)) {
  console.error('FAIL: pi binary not found — install devDependencies first (npm install).');
  process.exit(1);
}

const RAIL_FILE = 'test/contracts/frozen.test.ts';
const RAIL_CONTENT = 'export const CONTRACT = "must not change";\n';

// --- temp repo ------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'pi-live-deny-'));
const cleanup = () => rmSync(root, { recursive: true, force: true });

mkdirSync(join(root, 'test', 'contracts'), { recursive: true });
mkdirSync(join(root, '.adlc'), { recursive: true });
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, RAIL_FILE), RAIL_CONTENT);
writeFileSync(join(root, 'src', 'app.ts'), 'export {}\n');
writeFileSync(
  join(root, '.adlc', 'tickets.json'),
  JSON.stringify({ tickets: [{ id: 'T1', title: 'Live deny proof', body: 'Attempt a rail edit.', scope: ['src/**'], rails: ['test/contracts/**'] }] }, null, 2)
);
writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'ci@example.com');
git('config', 'user.name', 'CI');
git('add', '-A');
git('commit', '-qm', 'init');

// --- scripted stub provider (written into the temp repo) -------------------
const stubExtension = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

let call = 0;

function scriptedStream(model, _context, _options) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    call += 1;
    const base = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    };
    const output = call === 1
      ? { ...base, stopReason: "toolUse", content: [
          { type: "text", text: "Editing the contract now." },
          { type: "toolCall", id: "tc-rail-1", name: "write",
            arguments: { path: ${JSON.stringify(RAIL_FILE)}, content: "SABOTAGED" } },
        ] }
      : { ...base, stopReason: "stop", content: [ { type: "text", text: "DONE" } ] };
    stream.push({ type: "start", partial: output });
    stream.push({ type: "done", reason: output.stopReason, message: output });
  })();
  return stream;
}

export default function (pi) {
  pi.on("project_trust", async () => ({ trusted: "yes" }));
  pi.registerProvider("stub", {
    name: "Stub",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "stub",
    api: "openai-completions",
    models: [{
      id: "stub-1", name: "Stub 1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000, maxTokens: 8192,
    }],
    streamSimple: scriptedStream,
  });
}
`;
writeFileSync(join(root, 'stub-provider.ts'), stubExtension);

// --- drive pi over RPC ------------------------------------------------------
const child = spawn(piBin, [
  '--mode', 'rpc',
  '--no-session',
  '-e', adlcExtension,
  '-e', join(root, 'stub-provider.ts'),
  '--provider', 'stub',
  '--model', 'stub-1',
], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });

let stdoutBuf = '';
const events = [];
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* non-JSON noise */ }
  }
});
let stderrBuf = '';
child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

function finish(code, message) {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  if (message) (code === 0 ? console.log : console.error)(message);
  if (code !== 0) {
    console.error('--- events seen ---');
    for (const e of events.slice(-30)) console.error(JSON.stringify(e).slice(0, 400));
    console.error('--- stderr ---\n' + stderrBuf.slice(-4000));
  }
  cleanup();
  process.exit(code);
}

const timeout = setTimeout(() => finish(1, 'FAIL: timed out waiting for the agent turn to finish.'), 90_000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  finish(1, `FAIL: pi exited early (code ${code}).`);
});

child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'Edit the frozen contract file.' }) + '\n');

const poll = setInterval(() => {
  const done = events.some((e) => e.type === 'agent_end' || (e.type === 'response' && e.command === 'prompt' && e.success === false));
  if (!done) return;
  clearInterval(poll);
  clearTimeout(timeout);
  child.removeAllListeners('exit');

  const railNow = readFileSync(join(root, RAIL_FILE), 'utf8');
  const flat = JSON.stringify(events);
  const denied = /Blocked|frozen rail|GATE FAILED/i.test(flat);

  if (railNow !== RAIL_CONTENT) {
    finish(1, `FAIL: rail file was modified despite the gate:\n${railNow}`);
  } else if (!denied) {
    finish(1, 'FAIL: rail file unchanged but no deny evidence found in the event stream — the write may never have been attempted.');
  } else {
    finish(0, 'PASS: rail write denied inside a live pi agent loop; rail file byte-identical.');
  }
}, 250);
