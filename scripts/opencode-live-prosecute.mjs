#!/usr/bin/env node
// opencode-live-prosecute.mjs — T33 AC2/AC3: drive the SHIPPED adlc_prosecute
// tool's execute() end-to-end through the real plugin wiring, with a real-shaped
// mock SDK client scripting the lens/verifier child sessions.
//
// Why a mock client rather than the real opencode binary: a full multi-lens,
// multi-round prosecution loop driven by a mock PROVIDER inside opencode is
// non-deterministic and fragile. This proof instead loads the real
// plugins/adlc-opencode/index.mjs, registers the tool exactly as opencode would,
// and exercises its execute() against a mock `client.session` — proving the
// deterministic loop, the WRITE-DISABLED child sessions (AC2), and seeded-defect
// convergence (AC3) through first-party code. Registration/advertisement on the
// real binary is covered by scripts/opencode-live-tool.mjs.
//
// Exit codes: 0 = pass, 1 = fail.

import { buildProsecuteTool } from '../plugins/adlc-opencode/lib/prosecute-tool.mjs';
import { LENS_READ_TOOLS } from '../plugins/adlc-opencode/lib/prosecute-runner.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(REPO, 'plugins', 'adlc-opencode');
const log = (m) => console.log(`opencode-live-prosecute: ${m}`);
const fail = (m) => { console.error(`opencode-live-prosecute: FAIL — ${m}`); process.exit(1); };

const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';

// A real-shaped SDK client: records every child session.prompt so we can prove
// the tools disable-map, and scripts lens findings + a confirming verdict.
const prompts = [];
const client = {
  session: {
    create: async () => ({ data: { id: `child-${prompts.length}` } }),
    prompt: async (req) => {
      prompts.push(req);
      const system = req?.body?.system ?? '';
      // The verifier CONFIRMS the seeded defect; every lens SURFACES it.
      const reply = system.includes('verifier')
        ? fenced({ real: true, reason: 'reproduced the seeded off-by-one' })
        : fenced([{ title: 'seeded-off-by-one', severity: 'high', file: 'src/loop.mjs', detail: 'i <= n should be i < n' }]);
      return { data: { parts: [{ type: 'text', text: reply }] } };
    },
    delete: async () => ({ data: true }),
  },
};

// The minimal host zod the tool needs to declare its args (as opencode injects).
const { tool } = await import('@opencode-ai/plugin');
if (!tool?.schema) fail('@opencode-ai/plugin exposes no tool.schema');

const def = buildProsecuteTool(tool.schema, {
  root: REPO, pkgRoot: PKG, client,
  diffImpl: () => 'diff --git a/src/loop.mjs b/src/loop.mjs\n+  for (let i = 0; i <= n; i++)',
});
if (typeof def.adlc_prosecute?.execute !== 'function') fail('adlc_prosecute tool not built with an execute()');
log('adlc_prosecute tool built against the real host schema');

const result = await def.adlc_prosecute.execute({ base: 'main' }, { sessionID: 'live' });

// AC3: the seeded defect surfaces and the loop terminates with a NO-SHIP verdict.
if (result?.metadata?.deterministic !== true) fail('runner did not report a deterministic run');
if (result.metadata.confirmed < 1) fail('the seeded defect did not survive to a confirmed finding');
if (!/NO-SHIP/.test(result.metadata.verdict)) fail(`expected NO-SHIP, got ${result.metadata.verdict}`);
if (!/seeded-off-by-one/.test(result.output)) fail('the seeded finding is not in the report');
if (result.metadata.rounds < 1 || result.metadata.hitBound === 'maxSessions') fail(`loop did not terminate cleanly (rounds=${result.metadata.rounds}, bound=${result.metadata.hitBound})`);
log(`seeded defect converged: ${result.metadata.verdict} in ${result.metadata.rounds} round(s), ${result.metadata.sessionsUsed} child session(s)`);

// AC2: EVERY child session was FAIL-CLOSED — a wildcard-deny-first allowlist so
// unlisted tools (edit/write/task/MCP/unknown) inherit the "*" deny. Assert the
// closed boundary, not just that "some map was passed" (the denylist hollow-test
// codex caught): "*" is the first key and false; only read-only tools are
// re-allowed; write/sub-agent/unknown tools are NOT enabled.
if (prompts.length === 0) fail('no child sessions were spawned');
for (const p of prompts) {
  const tools = p?.body?.tools;
  if (!tools || Object.keys(tools)[0] !== '*' || tools['*'] !== false) {
    fail(`child session tools map is not wildcard-deny-first: ${JSON.stringify(tools)}`);
  }
  for (const t of LENS_READ_TOOLS) {
    if (tools[t] !== true) fail(`read-only tool "${t}" should be allowed`);
  }
  // write, the task sub-agent spawner, and an UNKNOWN/future tool must all be
  // denied — i.e. NOT re-enabled (they match only "*" → deny).
  for (const t of ['edit', 'write', 'patch', 'apply_patch', 'bash', 'shell', 'task', 'a_future_write_tool_xyz']) {
    if (tools[t] === true) fail(`tool "${t}" must NOT be enabled in a lens session (fails open)`);
  }
}
log(`all ${prompts.length} lens/verifier child sessions were fail-closed (wildcard-deny-first allowlist; task/unknown tools denied) (AC2)`);

// The loop ran in FIRST-PARTY code (the tool's execute drove it) — not the host
// model orchestrating — which is the whole point of the deterministic runner.
log('PASS — deterministic P5 loop drove seeded-defect convergence over write-disabled sessions');
