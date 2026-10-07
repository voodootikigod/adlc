#!/usr/bin/env node
// opencode-live-deny.mjs — AC7: the LIVE deny proof for the ADLC OpenCode plugin.
//
// Drives a REAL OpenCode 2.x binary end-to-end, with the plugin installed from
// `npm pack` tarballs, and proves the enforcement contract the plugin relies
// on: a thrown error in the v2 `ctx.tool.hook('execute.before')` aborts the
// tool call. No real model is needed — a local mock OpenAI-compatible server
// plays the model and always asks for a `write` to a frozen-rail path.
//
// Two runs, both against the same temp project:
//   1. CONTROL   (enforcement off): the write MUST land. This proves the mock
//      provider + tool loop actually executes the write — without it, a broken
//      harness would make the treatment run pass hollowly. A probe plugin also
//      records whether the host dispatched `permission.evaluate` for that write
//      (the hook the plugin's permission lever registers on) — printed as
//      `permission.evaluate invoked: yes|no`, and required.
//   2. TREATMENT (ADLC_P4_ENFORCEMENT=1): the rail file MUST be unchanged AND
//      the tool result the model receives (captured by the mock server on the
//      follow-up request) MUST contain the rails-guard deny message. The probe
//      line is printed for this run too: it reads `no`, because the plugin's
//      execute.before deny aborts the call before the host's permission step.
//   3. PATCH control + treatment: the same pair with a `gpt-5*` model, which
//      OpenCode gives the `patch` tool (a patchText envelope) instead of
//      edit/write.
//
// Exit codes: 0 = pass, 1 = fail, 3 = skipped (no `opencode` binary and not
// --require). CI passes --require so a missing binary can never silently skip.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeReporter, requireOpencodeV2, MOCK_PATCH_MODEL, installPackedPlugin, startMockProvider, reply,
  toolResultText, toolNames, createProject, writeConfig, writePermissionProbe, readProbe,
  gitInit, runOpencode, assertPluginsLoaded,
} from './opencode-live-harness.mjs';

const REQUIRE = process.argv.includes('--require');
const KEEP = process.argv.includes('--keep');
const RAIL = 'test/x.mjs';
const RAIL_ORIGINAL = 'export const frozen = true;\n';

const { log, fail } = makeReporter('opencode-live-deny');
log(`opencode ${requireOpencodeV2({ log, fail, require: REQUIRE })}`);

// Every conversation: first tool-bearing call → mutate test/x.mjs — `patch`
// when advertised (patchText envelope), else `write` with v2's `path`
// argument; any call that already carries a tool result → "done".
const PATCH_TEXT = `*** Begin Patch\n*** Update File: ${RAIL}\n@@\n-export const frozen = true;\n+export const frozen = false;\n*** End Patch\n`;
let toolResults = [];
const { server, baseURL } = await startMockProvider(({ messages, tools }) => {
  if (tools.length === 0) return reply.text('live deny proof'); // title/utility calls
  const results = messages.filter((m) => m.role === 'tool');
  if (results.length === 0) {
    return toolNames(tools).includes('patch')
      ? reply.toolCall('patch', { patchText: PATCH_TEXT })
      : reply.toolCall('write', { path: RAIL, content: 'OVERWRITTEN BY MODEL\n' });
  }
  toolResults.push(...results.map(toolResultText));
  return reply.text('done');
});
log(`mock provider at ${baseURL}`);

const { work, project, home, cleanup } = createProject('oc-live-deny-');
let exitCode = 1;
try {
  mkdirSync(join(project, 'test'), { recursive: true });
  writeFileSync(join(project, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'Live deny fixture', rails: ['test/**'] }] }, null, 2));
  writeFileSync(join(project, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  writeFileSync(join(project, RAIL), RAIL_ORIGINAL);
  log('installing the packed plugin…');
  const pluginDir = installPackedPlugin(project, join(work, 'packs'));
  const probeLog = join(work, 'permission-probe.jsonl');
  const probeDir = writePermissionProbe(join(work, 'probe'), probeLog);
  writeConfig(project, {
    baseURL,
    plugins: [probeDir, pluginDir],
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  });
  gitInit(project);

  const run = async (env, model) => { toolResults = []; const r = await runOpencode({ project, home, prompt: `Overwrite ${RAIL} please`, env, model }); return { ...r, toolResults: [...toolResults] }; };
  const evaluated = () => readProbe(probeLog).filter((d) => d.action === 'edit' && Array.isArray(d.resources) && d.resources.includes(RAIL));
  const dump = (r) => `exit=${r.status} timedOut=${r.timedOut} after ${r.seconds}s\ntool results: ${JSON.stringify(r.toolResults, null, 2)}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.split('\n').slice(-80).join('\n')}`;

  // ---- run 1: CONTROL (enforcement off) — the write must actually land ----
  log('control run (enforcement off)…');
  const control = await run({ ADLC_P4_ENFORCEMENT: '0' });
  assertPluginsLoaded(control, fail, 'control');
  if (readFileSync(join(project, RAIL), 'utf8') === RAIL_ORIGINAL) {
    fail(`CONTROL run did not write the file — the harness never executed the write, so the deny proof would be hollow.\n${dump(control)}`);
  }
  log('control: write landed (harness genuinely executes the tool)');
  const dispatched = evaluated();
  log(`control: permission.evaluate invoked: ${dispatched.length > 0 ? 'yes' : 'no'}`);
  if (dispatched.length === 0) {
    fail(`the host never dispatched permission.evaluate (action "edit", resources [${RAIL}]) for the control write — the plugin's permission lever has nothing to bind to.\nprobe: ${JSON.stringify(readProbe(probeLog))}`);
  }

  writeFileSync(join(project, RAIL), RAIL_ORIGINAL);

  // ---- run 2: TREATMENT (enforcement on) — the write must be BLOCKED ----
  log('treatment run (ADLC_P4_ENFORCEMENT=1)…');
  const treatment = await run({ ADLC_P4_ENFORCEMENT: '1' });
  assertPluginsLoaded(treatment, fail, 'treatment');
  if (readFileSync(join(project, RAIL), 'utf8') !== RAIL_ORIGINAL) {
    fail(`TREATMENT run WROTE to the frozen rail — the execute.before throw did NOT abort the tool.\n${dump(treatment)}`);
  }
  const DENY = 'ADLC rails-guard: blocked write — frozen rail "test/**"';
  if (!treatment.toolResults.some((t) => t.includes(DENY))) {
    fail(`rail file unchanged but the rails-guard deny naming the rail never reached the model — cannot attribute the block to the plugin.\n${dump(treatment)}`);
  }
  log('treatment: write blocked AND the deny reason reached the model');
  log(`treatment: permission.evaluate invoked: ${evaluated().length > dispatched.length ? 'yes' : 'no'} (execute.before denies first)`);

  // ---- run 3: PATCH control + treatment ----
  writeFileSync(join(project, RAIL), RAIL_ORIGINAL);
  log('patch control run (enforcement off)…');
  const patchControl = await run({ ADLC_P4_ENFORCEMENT: '0' }, MOCK_PATCH_MODEL);
  assertPluginsLoaded(patchControl, fail, 'patch control');
  if (readFileSync(join(project, RAIL), 'utf8') === RAIL_ORIGINAL) {
    fail(`PATCH CONTROL run did not apply the patch — the patch deny proof would be hollow.\n${dump(patchControl)}`);
  }
  log('patch control: patch applied');
  writeFileSync(join(project, RAIL), RAIL_ORIGINAL);
  log('patch treatment run (ADLC_P4_ENFORCEMENT=1)…');
  const patchTreatment = await run({ ADLC_P4_ENFORCEMENT: '1' }, MOCK_PATCH_MODEL);
  assertPluginsLoaded(patchTreatment, fail, 'patch treatment');
  if (readFileSync(join(project, RAIL), 'utf8') !== RAIL_ORIGINAL) {
    fail(`PATCH TREATMENT run modified the frozen rail.\n${dump(patchTreatment)}`);
  }
  if (!patchTreatment.toolResults.some((t) => t.includes('ADLC rails-guard: blocked patch — frozen rail "test/**"'))) {
    fail(`rail unchanged but the rails-guard patch deny never reached the model.\n${dump(patchTreatment)}`);
  }
  log('patch treatment: patch blocked AND the deny reason reached the model');
  log('PASS — live deny proof holds (AC7)');
  exitCode = 0;
} finally {
  server.close();
  if (KEEP) log(`--keep: temp project retained at ${work}`);
  else cleanup();
}
process.exit(exitCode);
