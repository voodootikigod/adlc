#!/usr/bin/env node
// pi-live-prosecute.mjs — live proof that the adlc-pi extension REGISTERS the
// native `adlc_prosecute` tool and that it is model-callable end-to-end inside a
// real `pi` agent loop (T26 AC5). Mirrors scripts/pi-live-deny.mjs.
//
// A temp git repo with an active ADLC ticket is created, then `pi --mode rpc` is
// launched with (a) the adlc-pi extension and (b) a scripted stub provider whose
// first turn tool-calls `adlc_prosecute` with base=HEAD. base=HEAD ⇒ an EMPTY
// diff ⇒ zero lenses ⇒ a CLEAN verdict WITHOUT spawning any child pi processes
// (the loop's fast path). The stub's second turn inspects the context it is
// handed and echoes whether the tool result reached it. We assert both the CLEAN
// tool result in the event stream AND that the model saw it.
//
// This exercises the real path: tool registration goes through TypeBox (a
// pi-runtime-only peer) and the real in-process execute() runs the real loop. If
// registration or callability regresses, this proof fails. No network, no keys.
//
// RPC framing note: strict JSONL with LF delimiters — Node readline is
// documented non-compliant (splits on U+2028/U+2029), so stdout is split
// manually on \n.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

// --- temp repo ------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'pi-live-prosecute-'));
const cleanup = () => rmSync(root, { recursive: true, force: true });

mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, '.adlc'), { recursive: true });
writeFileSync(join(root, 'src', 'app.ts'), 'export {}\n');
writeFileSync(
  join(root, '.adlc', 'tickets.json'),
  JSON.stringify({ tickets: [{ id: 'T1', title: 'Prosecute proof', body: 'Prove the tool runs.', scope: ['src/**'], rails: [] }] }, null, 2)
);
writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'ci@example.com');
git('config', 'user.name', 'CI');
git('add', '-A');
git('commit', '-qm', 'init');

// --- scripted stub provider (written into the temp repo) -------------------
// Turn 1: tool-call adlc_prosecute { base: "HEAD" }.
// Turn 2: stringify the context we were handed; if it carries the tool's CLEAN
//         result text, emit PROSECUTE_RESULT_SEEN so the harness can assert the
//         result round-tripped to the model.
const stubExtension = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

let call = 0;

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return "";
  }
}

function scriptedStream(model, context, _options) {
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
    let output;
    if (call === 1) {
      output = { ...base, stopReason: "toolUse", content: [
        { type: "text", text: "Prosecuting the change." },
        { type: "toolCall", id: "tc-prosecute-1", name: "adlc_prosecute",
          arguments: { base: "HEAD" } },
      ] };
    } else {
      const ctxText = safeStringify(context);
      const sawResult = ctxText.includes("ADLC prosecution") && ctxText.includes("CLEAN");
      output = { ...base, stopReason: "stop", content: [
        { type: "text", text: sawResult ? "PROSECUTE_RESULT_SEEN CLEAN" : "PROSECUTE_RESULT_MISSING" },
      ] };
    }
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

child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'Prosecute the current change.' }) + '\n');

const poll = setInterval(() => {
  const done = events.some((e) => e.type === 'agent_end' || (e.type === 'response' && e.command === 'prompt' && e.success === false));
  if (!done) return;
  clearInterval(poll);
  clearTimeout(timeout);
  child.removeAllListeners('exit');

  const flat = JSON.stringify(events);
  // Proof 1: the tool executed in-process and produced a CLEAN verdict.
  const cleanVerdict = /ADLC prosecution:\s*CLEAN/.test(flat);
  // Proof 2: the tool result round-tripped back to the model.
  const modelSawResult = /PROSECUTE_RESULT_SEEN/.test(flat);
  // Registration failure would surface as an unknown-tool error instead.
  const unknownTool = /unknown tool|tool .*adlc_prosecute.* not (found|registered)/i.test(flat);

  if (unknownTool) {
    finish(1, 'FAIL: adlc_prosecute was not registered (the model call hit an unknown tool).');
  } else if (!cleanVerdict) {
    finish(1, 'FAIL: no CLEAN adlc_prosecute verdict found in the event stream — the tool may not have run.');
  } else if (!modelSawResult) {
    finish(1, 'FAIL: the CLEAN tool result did not round-trip back to the model.');
  } else {
    finish(0, 'PASS: adlc_prosecute registered + model-callable in a live pi loop; empty-diff CLEAN verdict reached the model with no child spawns.');
  }
}, 250);
