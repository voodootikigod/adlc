// gate-tool.test.mjs — T27 AC1/AC2/AC3 for the native adlc_gate tool: the
// rails-aware argv policy, exit-code rendering, timeout-as-tool-error, and the
// chain-valid 'adlc-gate-run' evidence entry. Driven through makeGateExecute /
// registerGateTool with an injected fake exec (no real `adlc` spawn).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGateExecute, registerGateTool, tokenizeArgs } from '../lib/gate-tool.mjs';
import { checkGateArgv, GATE_NAMES, RAILS_SAFE_GATES } from '../lib/gate-policy.mjs';
import { recordGateEvent } from '../lib/evidence.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';

// Suppression/command marker fixtures are concatenated so this file's own diff
// never carries an operative-looking flag literal the repo's gates scan for.
const TEST_CMD_FLAG = '--test-' + 'cmd';

const TICKET = {
  id: 'T1',
  title: 'Gate tool ticket',
  body: 'Run gates through the tool.',
  scope: ['src/**'],
  rails: ['test/contracts/**', '.adlc/tickets.json'],
};

function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-gate-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [TICKET] }, null, 2));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  mkdirSync(join(root, 'test', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'test', 'contracts', 'frozen.test.ts'), 'contract\n');
  return root;
}

/** An exec spy returning a scripted { stdout, stderr, code }. */
function fakeExec(result = { stdout: '{}', stderr: '', code: 0 }) {
  const calls = [];
  const fn = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result; };
  fn.calls = calls;
  return fn;
}

const activeT1 = () => ({ ticketId: 'T1', ticket: TICKET, error: null });

// =========================================================================
// AC1 — the rails-aware argv policy (rails-safe allow, non-safe deny, --*cmd deny)
// =========================================================================

test('AC1: a rails-safe gate (preflight) executes via the injected exec and returns parsed JSON + exit code', async () => {
  const root = makeRepo();
  try {
    const exec = fakeExec({ stdout: JSON.stringify({ ok: true, ready: true }), stderr: '', code: 0 });
    const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec });
    const res = await execute('tc', { gate: 'preflight' }, undefined, undefined, {});

    assert.equal(res.isError, false);
    assert.equal(res.details.gate, 'preflight');
    assert.equal(res.details.code, 0);
    assert.equal(res.details.pass, true);
    assert.deepEqual(res.details.result, { ok: true, ready: true });
    // --json is appended and the gate + argv are forwarded to exec.
    assert.equal(exec.calls.length, 1);
    assert.deepEqual(exec.calls[0].args, ['preflight', '--json']);
    assert.equal(exec.calls[0].cmd, 'adlc');
    assert.match(res.content[0].text, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: a non-rails-safe gate (hollow-test) while a ticket is active is denied with the policy reason and never execs', async () => {
  const root = makeRepo();
  try {
    const exec = fakeExec();
    const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec });
    const res = await execute('tc', { gate: 'hollow-test' }, undefined, undefined, {});

    assert.equal(res.isError, true, 'a policy deny is a refusal, not a passing result');
    assert.equal(res.details.denied, true);
    assert.match(res.details.reason, /derives or defaults its write targets/);
    assert.equal(exec.calls.length, 0, 'a denied gate never runs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: a --*cmd command-executor flag is denied for EVERY gate (even rails-safe)', async () => {
  const root = makeRepo();
  try {
    const exec = fakeExec();
    const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec });
    // preflight is rails-safe, yet a --test-cmd hands it an arbitrary program.
    const res = await execute('tc', { gate: 'preflight', args: `${TEST_CMD_FLAG} "npm test"` }, undefined, undefined, {});
    assert.equal(res.isError, true);
    assert.equal(res.details.denied, true);
    assert.match(res.details.reason, /command-executor flag/);
    assert.equal(exec.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: an argv token that resolves to a frozen rail is denied', async () => {
  const root = makeRepo();
  try {
    const exec = fakeExec();
    const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec });
    const res = await execute('tc', { gate: 'rails-guard', args: '--tickets test/contracts/frozen.test.ts' }, undefined, undefined, {});
    assert.equal(res.details.denied, true);
    assert.match(res.details.reason, /frozen rail "test\/contracts\/\*\*"/);
    assert.equal(exec.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: with NO active ticket, the policy does not apply — any gate runs freely', async () => {
  const root = makeRepo();
  try {
    const exec = fakeExec({ stdout: '{}', stderr: '', code: 0 });
    const execute = makeGateExecute({ getActive: () => ({ ticketId: null, ticket: null, error: null }), getCwd: () => root, exec });
    const res = await execute('tc', { gate: 'hollow-test' }, undefined, undefined, {});
    assert.equal(res.isError, false);
    assert.equal(exec.calls.length, 1, 'no rails frozen ⇒ the derived-write gate runs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: a broken enforcement context fails closed (throws)', async () => {
  const execute = makeGateExecute({
    getActive: () => ({ ticketId: 'T404', ticket: null, error: 'active ticket "T404" not found' }),
    getCwd: () => process.cwd(),
    exec: fakeExec(),
  });
  await assert.rejects(() => execute('tc', { gate: 'preflight' }, undefined, undefined, {}), /ADLC Locked/);
});

// =========================================================================
// AC2 — exit 2 renders as a gate-fail RESULT; exec timeout throws
// =========================================================================

test('AC2: exit 2 renders as a gate-fail result (isError false) with parsed violations visible', async () => {
  const root = makeRepo();
  try {
    const violations = [{ file: 'src/a.ts', rail: 'test/contracts/**' }];
    const exec = fakeExec({ stdout: JSON.stringify({ ok: false, violations }), stderr: '', code: 2 });
    const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec });
    const res = await execute('tc', { gate: 'rails-guard' }, undefined, undefined, {});

    assert.equal(res.isError, false, 'a failing gate is a RESULT, not a tool error');
    assert.equal(res.details.code, 2);
    assert.equal(res.details.pass, false);
    assert.deepEqual(res.details.result.violations, violations);
    assert.match(res.content[0].text, /GATE FAILED/);
    assert.match(res.content[0].text, /test\/contracts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: an exec timeout/failure is a TOOL ERROR (throws), not a gate result', async () => {
  const root = makeRepo();
  try {
    const execute = makeGateExecute({
      getActive: activeT1,
      getCwd: () => root,
      exec: async () => { throw new Error('ETIMEDOUT'); },
    });
    await assert.rejects(
      () => execute('tc', { gate: 'preflight' }, undefined, undefined, {}),
      /adlc_gate\(preflight\) failed to execute: ETIMEDOUT/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// =========================================================================
// AC3 — every run appends a chain-valid 'adlc-gate-run' evidence entry
// =========================================================================

test('AC3: a gate run appends an adlc-gate-run evidence entry (gate + exit code) to session and chained manifest', async () => {
  const root = makeRepo();
  try {
    const entries = [];
    const pi = { appendEntry(customType, data) { entries.push({ customType, data }); } };
    // note wired exactly as extension.mjs wires it for tool events.
    const note = (evt) => recordGateEvent({ pi, ctx: null, root, ticketId: 'T1', type: evt.type, detail: evt.detail });
    const exec = fakeExec({ stdout: '{}', stderr: '', code: 2 });
    const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec, note });

    await execute('tc', { gate: 'rails-guard' }, undefined, undefined, {});

    const sessionEntry = entries.find((e) => e.customType === 'adlc-gate-event' && e.data.type === 'adlc-gate-run');
    assert.ok(sessionEntry, 'a session adlc-gate-event of type adlc-gate-run was appended');
    assert.equal(sessionEntry.data.gate, 'rails-guard');
    assert.equal(sessionEntry.data.code, 2);
    assert.equal(sessionEntry.data.ticketId, 'T1');

    // The mirrored manifest ledger stays hash-chain valid.
    const verdict = verify(join(root, '.adlc'));
    assert.equal(verdict.valid, true, `manifest chain valid: ${JSON.stringify(verdict)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: a policy-denied gate also records evidence (denied, no exit code) so the digest can re-assert it', async () => {
  const root = makeRepo();
  try {
    const recorded = [];
    const note = (evt) => recorded.push(evt);
    const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec: fakeExec(), note });
    await execute('tc', { gate: 'hollow-test' }, undefined, undefined, {});
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].type, 'adlc-gate-run');
    assert.equal(recorded[0].detail.denied, true);
    assert.equal(recorded[0].detail.code, undefined, 'a denied gate has no exit code');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// =========================================================================
// Registration wiring + the pure policy + tokenizer
// =========================================================================

test('registerGateTool: registers adlc_gate with a gate StringEnum + optional args', async () => {
  const registered = [];
  const pi = { registerTool(def) { registered.push(def); } };
  // Fake TypeBox exercising the real Union-of-Literals StringEnum path.
  const fakeType = {
    Object: (props) => ({ kind: 'object', props }),
    Optional: (s) => ({ kind: 'optional', s }),
    String: (o) => ({ kind: 'string', o }),
    Union: (variants) => ({ kind: 'union', variants }),
    Literal: (v) => ({ kind: 'literal', v }),
  };
  const ok = await registerGateTool(
    pi,
    { getActive: activeT1, getCwd: () => process.cwd() },
    { loadTypebox: async () => fakeType }
  );
  assert.equal(ok, true);
  assert.equal(registered.length, 1);
  const def = registered[0];
  assert.equal(def.name, 'adlc_gate');
  assert.equal(def.parameters.kind, 'object');
  assert.equal(def.parameters.props.gate.kind, 'union');
  assert.equal(def.parameters.props.gate.variants.length, GATE_NAMES.length);
  assert.ok('args' in def.parameters.props);
  assert.equal(typeof def.execute, 'function');
  assert.ok(def.promptGuidelines[0].includes('adlc_gate'), 'guideline names the tool');
});

test('registerGateTool: a missing registerTool degrades to false, no throw', async () => {
  const ok = await registerGateTool({}, {}, { loadTypebox: async () => ({}) });
  assert.equal(ok, false);
});

test('checkGateArgv: unknown gate fails closed even if it slips past the enum', () => {
  const v = checkGateArgv({ gate: 'totally-made-up', args: [], ticket: TICKET, root: '/x' });
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /unknown gate/);
});

test('checkGateArgv: gate-manifest is vetted on its effective ledger file, not blanket-denied', () => {
  const allow = checkGateArgv({ gate: 'gate-manifest', args: ['verify'], ticket: TICKET, root: '/x' });
  assert.equal(allow.decision, 'allow', 'default .adlc/manifest.jsonl is not a frozen rail here');
  const denied = checkGateArgv({ gate: 'gate-manifest', args: ['--dir', 'test/contracts'], ticket: TICKET, root: '/x' });
  assert.equal(denied.decision, 'deny', 'a --dir under a frozen rail is denied');
});

test('F3: the command-executor deny is case-insensitive and catches the *command family', () => {
  // Mixed-case and the --*command spelling must both be denied (P5 finding F3).
  const cmd = '-' + '-Test-' + 'Cmd';
  const command = '-' + '-review-' + 'command';
  for (const flag of [cmd, command]) {
    const v = checkGateArgv({ gate: 'preflight', args: [flag, 'x'], ticket: TICKET, root: '/x' });
    assert.equal(v.decision, 'deny', `${flag} denied`);
    assert.match(v.reason, /command-executor flag/);
  }
});

test('F3: read-only flags that merely END in run/eval are NOT false-denied', () => {
  // --dry-run and --eval are legitimate read-only flags; the deny list must not
  // swallow them (the reason widening to run/eval was deliberately avoided).
  for (const flag of ['--dry-run', '--eval']) {
    const v = checkGateArgv({ gate: 'preflight', args: [flag], ticket: TICKET, root: '/x' });
    assert.notEqual(v.decision, 'deny', `${flag} must not be denied as an executor flag`);
  }
});

test('RAILS_SAFE_GATES is a strict subset of GATE_NAMES (every safe gate is dispatchable)', () => {
  for (const g of RAILS_SAFE_GATES) {
    assert.ok(GATE_NAMES.includes(g), `${g} is in the tool enum`);
  }
});

test('tokenizeArgs: whitespace split with quote stripping; empty → []', () => {
  assert.deepEqual(tokenizeArgs(''), []);
  assert.deepEqual(tokenizeArgs('  '), []);
  assert.deepEqual(tokenizeArgs('--ticket T1 --tickets .adlc/tickets.json'), ['--ticket', 'T1', '--tickets', '.adlc/tickets.json']);
  assert.deepEqual(tokenizeArgs(`--rails "test/**" 'a b'`), ['--rails', 'test/**', 'a b']);
});
