#!/usr/bin/env node
// opencode-live-tool.mjs — LIVE proof for the native `adlc_gate` custom tool
// (Phase 4.2) on OpenCode 2.x. Drives a REAL `opencode` binary, with the plugin
// installed from `npm pack` tarballs, and a mock OpenAI-compatible provider,
// and proves the full path: the plugin's `ctx.tool.transform` adds adlc_gate →
// it is advertised to the model → the model calls it → execute() runs the
// LLM-backed gate keyless through `ctx.generate.text` → the verdict flows back
// to the model as the tool result.
//
// A fake `adlc` on PATH prints the gate's --prompt-only text carrying a marker;
// the mock answers the generate request carrying that marker with a canned
// verdict, so the verdict in the tool result proves the keyless round trip
// (not just that registration happened).
//
// Run with --require to make a missing binary fatal (CI); without it, a missing
// binary SKIPs (exit 3).

import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeReporter, requireOpencodeV2, installPackedPlugin, startMockProvider, reply,
  toolResultText, toolNames, createProject, writeConfig, gitInit, runOpencode,
  assertPluginsLoaded,
} from './opencode-live-harness.mjs';

const REQUIRE = process.argv.includes('--require');
const KEEP = process.argv.includes('--keep');
const KEYLESS_VERDICT = 'ADLC_KEYLESS_VERDICT_9C2E: spec is clear';
const GATE_PROMPT_MARKER = 'AUDIT_SPEC_PROMPT_5B1D';

const { log, fail } = makeReporter('opencode-live-tool');
log(`opencode ${requireOpencodeV2({ log, fail, require: REQUIRE })}`);

let advertisedAdlcGate = false;
let advertisedAdlcProsecute = false;
let keylessAnswered = false;
const toolResults = [];
const { server, baseURL } = await startMockProvider(({ messages, tools }) => {
  const names = toolNames(tools);
  if (names.includes('adlc_gate')) advertisedAdlcGate = true;
  if (names.includes('adlc_prosecute')) advertisedAdlcProsecute = true;
  // Keyless generate request: the gate's --prompt-only text reached the model.
  if (JSON.stringify(messages).includes(GATE_PROMPT_MARKER)) {
    keylessAnswered = true;
    return reply.text(KEYLESS_VERDICT);
  }
  if (tools.length === 0) return reply.text('ok');
  const results = messages.filter((m) => m.role === 'tool');
  if (results.length === 0) return reply.toolCall('adlc_gate', { gate: 'spec-lint' });
  toolResults.push(...results.map(toolResultText));
  return reply.text('done');
});
log(`mock provider at ${baseURL}`);

const { work, project, home, cleanup } = createProject('oc-live-tool-');
let exitCode = 1;
try {
  // Fake `adlc`: `spec-lint --prompt-only` prints a gate prompt carrying the
  // keyless marker, so the plugin routes it to ctx.generate.text.
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  const adlcShim = join(bin, 'adlc');
  writeFileSync(adlcShim,
    `#!/usr/bin/env bash\n` +
    `if [ "$1" = "--version" ]; then echo "1.11.1"; exit 0; fi\n` +
    `if [ "$1" = "spec-lint" ]; then echo "Audit this spec for clarity. ${GATE_PROMPT_MARKER}"; exit 0; fi\n` +
    `echo "unexpected: $*" 1>&2; exit 1\n`);
  chmodSync(adlcShim, 0o755);

  // Enforcement ON with an active ticket + a real rail — proves adlc_gate is not
  // denied by the plugin's own execute.before rail guard.
  writeFileSync(join(project, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'Live tool fixture', rails: ['locked/**'] }] }, null, 2));
  writeFileSync(join(project, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  log('installing the packed plugin…');
  const pluginDir = installPackedPlugin(project, join(work, 'packs'));
  writeConfig(project, { baseURL, plugins: [pluginDir], permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
  gitInit(project);

  log('running opencode: model calls adlc_gate(spec-lint) → keyless ctx.generate.text…');
  const r = await runOpencode({
    project, home, pathPrefix: bin,
    prompt: 'Run the spec-lint gate via adlc_gate',
    env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
  });
  assertPluginsLoaded(r, fail, 'run');
  const dump = `exit=${r.status} timedOut=${r.timedOut} after ${r.seconds}s\ntoolResults: ${JSON.stringify(toolResults, null, 2)}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.split('\n').slice(-80).join('\n')}`;

  if (!advertisedAdlcGate) fail(`adlc_gate was not advertised to the model — ctx.tool.transform did not add it.\n${dump}`);
  log('✓ adlc_gate registered and advertised to the model (4.2)');
  if (!advertisedAdlcProsecute) fail(`adlc_prosecute (T33) was not advertised alongside adlc_gate.\n${dump}`);
  log('✓ adlc_prosecute registered and advertised to the model (T33)');
  if (!keylessAnswered) fail(`adlc_gate ran an LLM-backed gate but the gate prompt never reached the model through ctx.generate.text.\n${dump}`);
  log('✓ the keyless path sent the gate prompt to the model (ctx.generate.text)');
  if (!toolResults.some((t) => t.includes(KEYLESS_VERDICT))) {
    fail(`the keyless request was answered, but its verdict never flowed back through adlc_gate to the model.\n${dump}`);
  }
  log('✓ the keyless verdict flowed back through adlc_gate to the model (4.1→4.2 wiring)');
  log('PASS — native adlc_gate tool + keyless bridge proven end-to-end');
  exitCode = 0;
} finally {
  server.close();
  if (KEEP) log(`--keep: ${work}`); else cleanup();
}
process.exit(exitCode);
