// gate-tool.test.mjs — Phase 4.2: the first-party adlc_gate dispatch core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, buildGateTool, LLM_BACKED_GATES } from '../lib/gate-tool.mjs';
import { GATE_BINS } from '../gate-bins.mjs';

// A minimal fake of the host's zod (`tool.schema`) — just enough for buildGateTool
// to declare its args without the @opencode-ai/plugin peer dependency.
const fakeSchema = {
  string: () => ({ _t: 'string', describe() { return this; } }),
  array: (of) => ({ _t: 'array', of, optional() { return { ...this, _opt: true }; }, describe() { return this; } }),
};

function stubSpawn({ status = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const fn = (bin, args, opts) => { calls.push({ bin, args, opts }); return { status, stdout, stderr }; };
  fn.calls = calls;
  return fn;
}

test('runs a known deterministic gate as `adlc <gate> [args]` and structures the result', () => {
  const spawnImpl = stubSpawn({ status: 0, stdout: 'preflight OK' });
  const r = runGate({ gate: 'preflight', args: ['--json'], spawnImpl, cwd: '/x' });
  assert.deepEqual(spawnImpl.calls[0].args, ['preflight', '--json']);
  assert.equal(spawnImpl.calls[0].bin, 'adlc');
  assert.equal(spawnImpl.calls[0].opts.cwd, '/x');
  assert.match(r.title, /adlc preflight → exit 0/);
  assert.equal(r.output, 'preflight OK');
  assert.equal(r.metadata.gate, 'preflight');
  assert.equal(r.metadata.exitCode, 0);
  assert.equal(r.metadata.llmBacked, false);
});

test('unknown gate → structured error, does NOT spawn', () => {
  const spawnImpl = stubSpawn();
  const r = runGate({ gate: 'definitely-not-a-gate', spawnImpl });
  assert.equal(spawnImpl.calls.length, 0);
  assert.equal(r.metadata.error, 'unknown-gate');
  assert.match(r.output, /not a known ADLC gate/);
});

test('every declared GATE_BIN is accepted (no gate rejected as unknown)', () => {
  const spawnImpl = stubSpawn({ status: 0, stdout: 'ok' });
  for (const g of GATE_BINS) {
    assert.notEqual(runGate({ gate: g, spawnImpl }).metadata.error, 'unknown-gate', `${g} accepted`);
  }
});

test('non-zero exit is surfaced structurally, not thrown', () => {
  const spawnImpl = stubSpawn({ status: 2, stdout: '', stderr: 'spec unclear' });
  const r = runGate({ gate: 'spec-lint', spawnImpl });
  assert.equal(r.metadata.exitCode, 2);
  assert.match(r.output, /spec unclear/);
});

test('LLM-backed gate failing on a missing key gets a keyless hint', () => {
  const spawnImpl = stubSpawn({ status: 1, stderr: 'no API key configured for provider' });
  const r = runGate({ gate: 'parallax', spawnImpl });
  assert.equal(r.metadata.llmBacked, true);
  assert.match(r.output, /keyless.*--prompt-only/);
});

test('spawn throwing → structured spawn-failed result (no crash)', () => {
  const spawnImpl = () => { throw new Error('ENOENT adlc'); };
  const r = runGate({ gate: 'preflight', spawnImpl });
  assert.equal(r.metadata.error, 'spawn-failed');
  assert.match(r.output, /@adlc\/cli/);
});

test('args are coerced to strings and default to []', () => {
  const spawnImpl = stubSpawn({ status: 0, stdout: 'ok' });
  runGate({ gate: 'preflight', args: [123, true], spawnImpl });
  assert.deepEqual(spawnImpl.calls[0].args, ['preflight', '123', 'true']);
  const s2 = stubSpawn({ status: 0, stdout: 'ok' });
  runGate({ gate: 'preflight', spawnImpl: s2 });
  assert.deepEqual(s2.calls[0].args, ['preflight']);
});

test('LLM_BACKED_GATES is a subset of GATE_BINS (no phantom gates)', () => {
  for (const g of LLM_BACKED_GATES) assert.ok(GATE_BINS.includes(g), `${g} is a real gate`);
});

// ---- buildGateTool: the tool-hook definition the model calls ----
test('buildGateTool: shapes an adlc_gate ToolDefinition with gate+args', () => {
  const def = buildGateTool(fakeSchema, { root: '/proj' });
  assert.ok(def.adlc_gate, 'registers under adlc_gate');
  assert.match(def.adlc_gate.description, /ADLC lifecycle gate/);
  assert.ok(def.adlc_gate.args.gate, 'has a gate arg');
  assert.ok(def.adlc_gate.args.args, 'has an args arg');
  assert.equal(typeof def.adlc_gate.execute, 'function');
});

test('buildGateTool.execute: runs the gate, reports metadata, returns structured output', async () => {
  const spawnCalls = [];
  const spawnImpl = (bin, args, opts) => { spawnCalls.push({ bin, args, opts }); return { status: 0, stdout: 'preflight OK' }; };
  const def = buildGateTool(fakeSchema, { root: '/proj', spawnImpl });
  const meta = [];
  const ctx = { directory: '/session/dir', metadata: (m) => meta.push(m) };
  const result = await def.adlc_gate.execute({ gate: 'preflight', args: ['--json'] }, ctx);
  // executed in the session directory, not the plugin root
  assert.equal(spawnCalls[0].opts.cwd, '/session/dir');
  assert.deepEqual(spawnCalls[0].args, ['preflight', '--json']);
  assert.match(result.output, /preflight OK/);
  assert.equal(result.metadata.gate, 'preflight');
  assert.equal(meta[0].title, result.title); // reported via ctx.metadata
});

test('buildGateTool.execute: unknown gate returns a structured error (no throw)', async () => {
  const def = buildGateTool(fakeSchema, { spawnImpl: () => ({ status: 0, stdout: '' }) });
  const r = await def.adlc_gate.execute({ gate: 'nope' }, {});
  assert.equal(r.metadata.error, 'unknown-gate');
});

// ---- keyless wiring (4.1 → 4.2): LLM-backed gates run through the host model ----
function mockSessionClient(reply = 'SPEC IS CLEAR') {
  const calls = { create: 0, prompt: [] };
  return {
    calls,
    session: {
      create: async () => { calls.create++; return { data: { id: 'child' } }; },
      prompt: async (req) => { calls.prompt.push(req); return { data: { parts: [{ type: 'text', text: reply }] } }; },
      delete: async () => ({ data: true }),
    },
  };
}

test('LLM-backed gate + client → keyless via child session (not a CLI run)', async () => {
  const client = mockSessionClient('SPEC IS CLEAR');
  // stub the gate's --prompt-only stdout so no real `adlc` is needed
  const spawnImpl = (_bin, args) => {
    assert.ok(args.includes('--prompt-only'), 'LLM gate runs in --prompt-only');
    assert.ok(args.includes('spec-lint'));
    return { status: 0, stdout: 'audit this spec for clarity' };
  };
  const def = buildGateTool(fakeSchema, { root: '/p', client, spawnImpl });
  const r = await def.adlc_gate.execute({ gate: 'spec-lint' }, { sessionID: 'parent', directory: '/p' });
  assert.equal(r.metadata.keyless, true);
  assert.equal(client.calls.create, 1, 'spawned a child session');
  assert.match(r.output, /SPEC IS CLEAR/);
});

test('LLM-backed gate but NO client → falls back to the CLI (no crash)', async () => {
  const spawnImpl = (_bin, args) => {
    // without --prompt-only this is the plain CLI path
    assert.ok(!args.includes('--prompt-only'));
    return { status: 1, stderr: 'no API key configured for provider' };
  };
  const def = buildGateTool(fakeSchema, { root: '/p', spawnImpl }); // no client
  const r = await def.adlc_gate.execute({ gate: 'spec-lint' }, {});
  assert.notEqual(r.metadata.keyless, true);
  assert.match(r.output, /keyless.*--prompt-only/); // CLI path surfaces the keyless hint
});

test('deterministic gate ignores the client and runs the CLI', async () => {
  const client = mockSessionClient();
  const spawnImpl = (_bin, args) => { assert.ok(!args.includes('--prompt-only')); return { status: 0, stdout: 'ok' }; };
  const def = buildGateTool(fakeSchema, { client, spawnImpl });
  const r = await def.adlc_gate.execute({ gate: 'preflight' }, {});
  assert.equal(client.calls.create, 0, 'no child session for a deterministic gate');
  assert.notEqual(r.metadata.keyless, true);
});

// ---- P5 finding: adlc_gate must survive the rails guard's tool.execute.before ----
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adlcRailsGuard } from '../index.mjs';

test('adlc_gate is NOT denied by tool.execute.before under active enforcement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-gate-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', rails: ['test/**'] }] }));
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    const hooks = await adlcRailsGuard({ worktree: dir });
    // The model calling adlc_gate must reach execute(), not be denied as an
    // unknown mutator. before-hook receives (input, output); adlc_gate carries
    // no file target, so it must resolve (not throw).
    await hooks['tool.execute.before']({ tool: 'adlc_gate', sessionID: 's', callID: 'c' }, { args: { gate: 'spec-lint' } });
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

// ---- P5 findings (prosecution of eeabca7): real-schema + rejection coverage ----

test('buildGateTool accepts the REAL @opencode-ai/plugin tool.schema (upstream shape guard)', async () => {
  // The fakeSchema tests prove our logic; this proves the actual peer contract.
  // If upstream changes tool.schema's zod surface, this fails in `npm test`
  // instead of only in the heavier live harness.
  const { tool } = await import('@opencode-ai/plugin');
  assert.ok(tool?.schema, 'tool.schema exported');
  const def = buildGateTool(tool.schema, { root: '/p', spawnImpl: () => ({ status: 0, stdout: 'ok' }) });
  assert.ok(def.adlc_gate, 'definition built against real schema');
  assert.equal(def.adlc_gate.args.gate.parse('preflight'), 'preflight');
  const r = await def.adlc_gate.execute({ gate: 'preflight' }, {});
  assert.equal(r.metadata.exitCode, 0);
});

test('non-timeout session.prompt rejection → structured keyless-failed (never a throw)', async () => {
  const client = {
    session: {
      create: async () => ({ data: { id: 'child' } }),
      prompt: async () => { throw new Error('boom: provider 500'); },
      delete: async () => ({ data: true }),
    },
  };
  const spawnImpl = () => ({ status: 0, stdout: 'audit this spec' });
  const def = buildGateTool(fakeSchema, { root: '/p', client, spawnImpl });
  const r = await def.adlc_gate.execute({ gate: 'spec-lint' }, { sessionID: 'parent' });
  assert.equal(r.metadata.error, 'keyless-failed');
  assert.match(r.output, /boom: provider 500/);
});
