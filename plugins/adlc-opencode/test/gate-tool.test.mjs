// gate-tool.test.mjs — Phase 4.2: the first-party adlc_gate dispatch core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, buildGateTool, LLM_BACKED_GATES } from '../lib/gate-tool.mjs';
import { GATE_BINS } from '../gate-bins.mjs';

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

// ---- buildGateTool: the v2 Tool.Info the model calls ----
const TOOL_CTX = { sessionID: 'ses_parent', agent: 'build', messageID: 'msg_1', id: 'call_1' };

test('buildGateTool: shapes an adlc_gate v2 Tool.Info with a JSON Schema input', () => {
  const def = buildGateTool({ root: '/proj' });
  assert.equal(def.name, 'adlc_gate');
  assert.match(def.description, /ADLC lifecycle gate/);
  assert.deepEqual(def.input, {
    type: 'object',
    properties: {
      gate: { type: 'string', description: def.input.properties.gate.description },
      args: { type: 'array', items: { type: 'string' }, description: def.input.properties.args.description },
    },
    required: ['gate'],
    additionalProperties: false,
  });
  assert.equal(typeof def.execute, 'function');
});

test('buildGateTool.execute: runs the gate in the plugin root and returns a v2 Tool.Result', async () => {
  const spawnCalls = [];
  const spawnImpl = (bin, args, opts) => { spawnCalls.push({ bin, args, opts }); return { status: 0, stdout: 'preflight OK' }; };
  const def = buildGateTool({ root: '/proj', spawnImpl });
  const result = await def.execute({ gate: 'preflight', args: ['--json'] }, TOOL_CTX);
  // v2 tool contexts carry no directory: the gate runs in the plugin root
  assert.equal(spawnCalls[0].opts.cwd, '/proj');
  assert.deepEqual(spawnCalls[0].args, ['preflight', '--json']);
  assert.equal(typeof result.content, 'string');
  assert.match(result.content, /^adlc preflight → exit 0\n\npreflight OK$/);
  assert.equal(result.metadata.gate, 'preflight');
  assert.equal(result.metadata.title, 'adlc preflight → exit 0');
});

test('buildGateTool.execute: unknown gate returns a structured error (no throw)', async () => {
  const def = buildGateTool({ spawnImpl: () => ({ status: 0, stdout: '' }) });
  const r = await def.execute({ gate: 'nope' }, TOOL_CTX);
  assert.equal(r.metadata.error, 'unknown-gate');
});

// ---- keyless wiring (4.1 → 4.2): LLM-backed gates run through the host model ----
function mockGenerate(reply = 'SPEC IS CLEAR') {
  const calls = [];
  return { calls, text: async (req) => { calls.push(req); return { text: reply }; } };
}

test('LLM-backed gate + generate API → keyless via ctx.generate.text (not a CLI run)', async () => {
  const generate = mockGenerate('SPEC IS CLEAR');
  // stub the gate's --prompt-only stdout so no real `adlc` is needed
  const spawnImpl = (_bin, args) => {
    assert.ok(args.includes('--prompt-only'), 'LLM gate runs in --prompt-only');
    assert.ok(args.includes('spec-lint'));
    return { status: 0, stdout: 'audit this spec for clarity' };
  };
  const def = buildGateTool({ root: '/p', generate, spawnImpl });
  const r = await def.execute({ gate: 'spec-lint' }, TOOL_CTX);
  assert.equal(r.metadata.keyless, true);
  assert.deepEqual(generate.calls, [{ prompt: 'audit this spec for clarity' }], 'one tool-less generation per prompt');
  assert.match(r.content, /SPEC IS CLEAR/);
});

test('LLM-backed gate but NO generate API → falls back to the CLI (no crash)', async () => {
  const spawnImpl = (_bin, args) => {
    // without --prompt-only this is the plain CLI path
    assert.ok(!args.includes('--prompt-only'));
    return { status: 1, stderr: 'no API key configured for provider' };
  };
  const def = buildGateTool({ root: '/p', spawnImpl }); // no generate API
  const r = await def.execute({ gate: 'spec-lint' }, TOOL_CTX);
  assert.notEqual(r.metadata.keyless, true);
  assert.match(r.content, /keyless.*--prompt-only/); // CLI path surfaces the keyless hint
});

test('deterministic gate ignores the generate API and runs the CLI', async () => {
  const generate = mockGenerate();
  const spawnImpl = (_bin, args) => { assert.ok(!args.includes('--prompt-only')); return { status: 0, stdout: 'ok' }; };
  const def = buildGateTool({ generate, spawnImpl });
  const r = await def.execute({ gate: 'preflight' }, TOOL_CTX);
  assert.equal(generate.calls.length, 0, 'no model call for a deterministic gate');
  assert.notEqual(r.metadata.keyless, true);
});

// ---- P5 finding: adlc_gate must survive the rails guard's execute.before ----
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin } from './helpers/fake-ctx.mjs';

test('adlc_gate is NOT denied by execute.before under active enforcement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-gate-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', rails: ['test/**'] }] }));
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    const plugin = await loadPlugin({ root: dir });
    // The model calling adlc_gate must reach execute(), not be denied as an
    // unknown mutator. adlc_gate carries no file target, so it must resolve.
    await plugin.before('adlc_gate', { gate: 'spec-lint' });
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

// ---- P5 findings (prosecution of eeabca7): real-schema + rejection coverage ----

test('setup registers adlc_gate and adlc_prosecute through ctx.tool.transform', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-gate-'));
  try {
    const plugin = await loadPlugin({ root: dir, generate: mockGenerate() });
    const tools = plugin.tools();
    assert.deepEqual([...tools.keys()].sort(), ['adlc_gate', 'adlc_prosecute']);
    for (const t of tools.values()) {
      assert.equal(t.input.type, 'object');
      assert.equal(t.input.additionalProperties, false, `${t.name} rejects unknown input keys`);
      // Code Mode tools are reachable only via `execute`, which rails deny.
      assert.equal(t.options?.codemode, false, `${t.name} is a direct (non-Code-Mode) tool`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('non-timeout generate.text rejection → structured keyless-failed (never a throw)', async () => {
  const generate = { text: async () => { throw new Error('boom: provider 500'); } };
  const spawnImpl = () => ({ status: 0, stdout: 'audit this spec' });
  const def = buildGateTool({ root: '/p', generate, spawnImpl });
  const r = await def.execute({ gate: 'spec-lint' }, TOOL_CTX);
  assert.equal(r.metadata.error, 'keyless-failed');
  assert.match(r.content, /boom: provider 500/);
});

// ---- P5 cross-model finding: keyless set must equal the gates that IMPLEMENT --prompt-only ----

test('LLM_BACKED_GATES equals EXACTLY the gates implementing --prompt-only (two-way audit)', async () => {
  // skill-rot (and merge-forecast, model-router, hollow-test, behavior-diff)
  // reject --prompt-only with ERR_PARSE_ARGS_UNKNOWN_OPTION; routing them
  // keyless made a working gate fail. Ground the set in each package's source,
  // BOTH ways: a member must implement the flag, and a gate that grows the
  // flag later must be added to the set (drift fails this test, not runtime).
  const { readdirSync, readFileSync: rf, existsSync } = await import('node:fs');
  const pkgRoot = new URL('../../../packages/', import.meta.url).pathname;
  for (const gate of GATE_BINS) {
    const dir = join(pkgRoot, gate);
    assert.ok(existsSync(dir), `packages/${gate} exists`);
    const sources = [];
    for (const sub of ['bin', 'lib']) {
      const d = join(dir, sub);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (f.endsWith('.mjs')) sources.push(rf(join(d, f), 'utf8'));
    }
    const implementsPromptOnly = sources.some((s) => s.includes('prompt-only'));
    assert.equal(
      LLM_BACKED_GATES.has(gate), implementsPromptOnly,
      `packages/${gate}: prompt-only support (${implementsPromptOnly}) must match LLM_BACKED_GATES membership (${LLM_BACKED_GATES.has(gate)})`,
    );
  }
});

test('a GENUINE prompt-only failure surfaces as keyless-failed, not a silent CLI downgrade', async () => {
  const generate = mockGenerate('unused');
  const calls = [];
  const spawnImpl = (_bin, args) => {
    calls.push(args);
    // supports --prompt-only, but crashes for a real reason (bad args, bug)
    return { status: 1, stderr: 'TypeError: cannot read spec — boom' };
  };
  const def = buildGateTool({ root: '/p', generate, spawnImpl });
  const r = await def.execute({ gate: 'spec-lint' }, TOOL_CTX);
  assert.equal(r.metadata.error, 'keyless-failed', 'genuine failure surfaced');
  assert.equal(calls.length, 1, 'no silent CLI fallback for a genuine failure');
});

test('a gate rejecting --prompt-only falls back to the plain CLI, not keyless-failed', async () => {
  const generate = mockGenerate('unused');
  const calls = [];
  const spawnImpl = (_bin, args) => {
    calls.push(args);
    if (args.includes('--prompt-only')) return { status: 1, stderr: 'ERR_PARSE_ARGS_UNKNOWN_OPTION: --prompt-only' };
    return { status: 0, stdout: 'gate ran via CLI' };
  };
  // force the keyless path with a gate name in the set, whose CLI rejects the flag
  const def = buildGateTool({ root: '/p', generate, spawnImpl });
  const r = await def.execute({ gate: 'spec-lint' }, TOOL_CTX);
  assert.notEqual(r.metadata.error, 'keyless-failed', 'fell back instead of failing');
  assert.equal(r.metadata.exitCode, 0);
  assert.match(r.content, /gate ran via CLI/);
  assert.equal(calls.length, 2, 'prompt-only attempt then CLI fallback');
});

test('non-keyless gate (skill-rot) with a generate API runs the plain CLI, never --prompt-only', async () => {
  const generate = mockGenerate('unused');
  const spawnImpl = (_bin, args) => {
    assert.ok(!args.includes('--prompt-only'), 'skill-rot must not be routed keyless');
    return { status: 0, stdout: 'rot report' };
  };
  const def = buildGateTool({ generate, spawnImpl });
  const r = await def.execute({ gate: 'skill-rot' }, TOOL_CTX);
  assert.equal(generate.calls.length, 0, 'no model call');
  assert.equal(r.metadata.exitCode, 0);
});
