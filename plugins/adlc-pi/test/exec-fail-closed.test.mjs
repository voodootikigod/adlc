// exec-fail-closed.test.mjs — issues #840 and #841.
//
// Two false-greens with one shape: a gate/prosecution that produced NO result
// was reported as a passing one.
//
//  #840 pi's execCommand resolves a SIGTERM-killed child as `{ code: 0,
//       killed: true }` (a signal death has no exit code, and it normalizes
//       `code ?? 0`). adlc_gate derived its verdict from `res.code` alone, so a
//       gate killed at the 120s timeout rendered `PASS (exit 0)` with
//       `details.pass === true` and recorded an 'adlc-gate-run' evidence entry
//       that shutdown.mjs reads as state-resolving. `res.killed` was never read.
//  #841 prosecute() computed its verdict from confirmed findings alone, so a
//       round in which EVERY lens degraded (missing binary, no credentials,
//       per-lens deadline) produced verdict 'CLEAN' while renderSummary printed
//       'Degraded lenses (not counted as clean)' in the same block.
//
// The fix is one exported predicate (execFailureReason) shared by both exec
// call sites, and a third prosecution verdict (INCONCLUSIVE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGateExecute, execFailureReason } from '../lib/gate-tool.mjs';
import { prosecute, renderSummary } from '../lib/prosecutor.mjs';
import { createExtension } from '../lib/extension.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TICKET = {
  id: 'T1',
  title: 'Gate tool ticket',
  body: 'Run gates through the tool.',
  scope: ['src/**'],
  rails: ['test/contracts/**', '.adlc/tickets.json'],
};

function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-failclosed-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [TICKET] }, null, 2));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  mkdirSync(join(root, 'test', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'test', 'contracts', 'frozen.test.ts'), 'contract\n');
  return root;
}

/** An exec spy returning a scripted result. */
function fakeExec(result) {
  const calls = [];
  const fn = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result; };
  fn.calls = calls;
  return fn;
}

/** A note() spy standing in for the evidence sink. */
function noteSpy() {
  const events = [];
  const fn = (evt) => { events.push(evt); };
  fn.events = events;
  return fn;
}

const activeT1 = () => ({ ticketId: 'T1', ticket: TICKET, error: null });

/**
 * Run adlc_gate against a scripted exec result. `preflight` is rails-safe, so
 * the argv policy allows it and the exec result is what decides the outcome.
 */
async function runGate(root, result) {
  const exec = fakeExec(result);
  const note = noteSpy();
  const execute = makeGateExecute({ getActive: activeT1, getCwd: () => root, exec, note });
  return { exec, note, execute };
}

// =========================================================================
// AC1 / AC2 / AC3 — a killed or codeless exec is a TOOL ERROR, never a PASS
// =========================================================================

test('AC1: a gate exec killed at the timeout ({code:0, killed:true}) throws instead of reporting PASS', async () => {
  const root = makeRepo();
  try {
    const { execute } = await runGate(root, { stdout: '', stderr: '', code: 0, killed: true });
    await assert.rejects(
      () => execute('tc', { gate: 'preflight' }, undefined, undefined, {}),
      (err) => {
        assert.match(err.message, /adlc_gate\(preflight\) failed to execute/);
        assert.doesNotMatch(err.message, /PASS/);
        return true;
      },
      'a killed exec must surface as a tool error, not a gate verdict'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: the thrown message names the kill so the model can tell a hang from a gate failure', async () => {
  const root = makeRepo();
  try {
    const { execute } = await runGate(root, { stdout: '', stderr: '', code: 0, killed: true });
    await assert.rejects(
      () => execute('tc', { gate: 'preflight' }, undefined, undefined, {}),
      /killed/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: an exec that reports no numeric exit code throws rather than degrading to a gate failure', async () => {
  const root = makeRepo();
  try {
    for (const result of [
      { stdout: '', stderr: '', code: undefined },
      { stdout: '', stderr: '', code: null },
      { stdout: '', stderr: '', code: 'nope' },
      undefined,
    ]) {
      const { execute } = await runGate(root, result);
      await assert.rejects(
        () => execute('tc', { gate: 'preflight' }, undefined, undefined, {}),
        /adlc_gate\(preflight\) failed to execute/,
        `a result of ${JSON.stringify(result ?? null)} must throw`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: a normal pass ({code:0, killed:false}) still returns details.pass true', async () => {
  const root = makeRepo();
  try {
    const { execute } = await runGate(root, {
      stdout: JSON.stringify({ ok: true, ready: true }), stderr: '', code: 0, killed: false,
    });
    const res = await execute('tc', { gate: 'preflight' }, undefined, undefined, {});
    assert.equal(res.isError, false);
    assert.equal(res.details.code, 0);
    assert.equal(res.details.pass, true);
    assert.match(res.content[0].text, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: an exec with no `killed` field at all is still a normal result (pi omits it on success)', async () => {
  const root = makeRepo();
  try {
    const { execute } = await runGate(root, { stdout: '{}', stderr: '', code: 0 });
    const res = await execute('tc', { gate: 'preflight' }, undefined, undefined, {});
    assert.equal(res.details.pass, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: a gate that FAILS (exit 2) is still a result, not a tool error', async () => {
  const root = makeRepo();
  try {
    const violations = ['rail test/contracts/frozen.test.ts was modified'];
    const { execute } = await runGate(root, {
      stdout: JSON.stringify({ ok: false, violations }), stderr: '', code: 2, killed: false,
    });
    const res = await execute('tc', { gate: 'preflight' }, undefined, undefined, {});
    assert.equal(res.isError, false);
    assert.equal(res.details.code, 2);
    assert.equal(res.details.pass, false);
    assert.match(res.content[0].text, /GATE FAILED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: no adlc-gate-run evidence entry is recorded when the exec was killed', async () => {
  const root = makeRepo();
  try {
    const { execute, note } = await runGate(root, { stdout: '', stderr: '', code: 0, killed: true });
    await assert.rejects(() => execute('tc', { gate: 'preflight' }, undefined, undefined, {}));
    assert.equal(
      note.events.length, 0,
      'a killed exec must not leave a code-0 gate-run entry — shutdown.mjs reads that as state-resolving'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: a successful exec still records exactly one adlc-gate-run entry', async () => {
  const root = makeRepo();
  try {
    const { execute, note } = await runGate(root, { stdout: '{}', stderr: '', code: 2, killed: false });
    await execute('tc', { gate: 'preflight' }, undefined, undefined, {});
    assert.equal(note.events.length, 1);
    assert.equal(note.events[0].type, 'adlc-gate-run');
    assert.equal(note.events[0].detail.code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// =========================================================================
// AC4 — one exported predicate, spelled once, used by every exec call site
// =========================================================================

test('AC4: execFailureReason is exported and classifies killed / codeless / healthy results', () => {
  assert.equal(typeof execFailureReason, 'function');
  assert.match(execFailureReason({ code: 0, killed: true }) ?? '', /killed/i);
  assert.match(execFailureReason({ code: 2, killed: true }) ?? '', /killed/i);
  assert.match(execFailureReason({ killed: false }) ?? '', /exit code/i);
  assert.match(execFailureReason({ code: null }) ?? '', /exit code/i);
  assert.match(execFailureReason(undefined) ?? '', /exit code/i);
  assert.match(execFailureReason(null) ?? '', /exit code/i);
  assert.equal(execFailureReason({ code: 0, killed: false }), null);
  assert.equal(execFailureReason({ code: 2 }), null);
  assert.equal(execFailureReason({ code: 0 }), null);
});

test('AC4: the killed/codeless condition is spelled in exactly one source file', () => {
  const files = ['lib/gate-tool.mjs', 'lib/commands.mjs', 'lib/prosecutor.mjs', 'lib/prosecute-tool.mjs'];
  const spellings = files.filter((f) => {
    const src = readFileSync(join(PLUGIN_ROOT, f), 'utf8');
    return /\.killed\s*===\s*true|killed\s*===\s*true/.test(src);
  });
  assert.deepEqual(
    spellings, ['lib/gate-tool.mjs'],
    'only gate-tool.mjs may spell the killed condition — every other call site imports execFailureReason'
  );
});

test('AC4: /adlc-accept fails closed through the same predicate', () => {
  const src = readFileSync(join(PLUGIN_ROOT, 'lib/commands.mjs'), 'utf8');
  assert.match(src, /execFailureReason/, 'commands.mjs must import the shared predicate');
  assert.doesNotMatch(
    src,
    /const ok = parsed \? parsed\.ok === true : res\?\.code === 0;/,
    'the raw exit-code-only ok computation must be gone'
  );
});

// ── AC4, driven through the real /adlc-accept handler ─────────────────────
// The three branches of its `ok`: a killed exec, and (with no JSON on stdout,
// so the exit code decides) a zero and a non-zero code.

function fakePi({ exec } = {}) {
  const handlers = {};
  const commands = {};
  const entries = [];
  const execCalls = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    registerMessageRenderer() {},
    sendMessage() {},
    async exec(cmd, args) {
      execCalls.push({ cmd, args });
      if (typeof exec === 'function') return exec(cmd, args);
      return { stdout: '', stderr: '', code: 0 };
    },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    handlers, commands, entries, execCalls,
  };
}

function fakeCtx(cwd, { confirm } = {}) {
  const notices = [];
  return {
    cwd,
    hasUI: true,
    ui: {
      setStatus() {}, setWidget() {},
      notify(msg, level) { notices.push({ msg, level }); },
      async select(_t, options) { return options[0]; },
      async confirm() { return typeof confirm === 'function' ? confirm() : true; },
    },
    notices,
  };
}

async function bootAccept(root, exec) {
  const pi = fakePi({ exec });
  createExtension({ env: {} })(pi);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, fakeCtx(root));
  return pi;
}

function makeAcceptRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-accept-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  const t1 = {
    id: 'T1', title: 'First ticket', body: 'Do the first thing',
    scope: ['src/**'], rails: ['test/contracts/**'], edges: [], duration: 1, category: 'feature',
  };
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [t1] }, null, 2));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  writeFileSync(join(root, '.adlc', 'packet.json'), JSON.stringify({ ticket: 'T1' }));
  return root;
}

/** `accept` returns non-JSON stdout, so `res.code` alone decides the outcome. */
function acceptExecWith(acceptResult) {
  return (cmd, args) => (args[0] === 'accept' ? acceptResult : { stdout: '', stderr: '', code: 0 });
}

async function runAccept(acceptResult) {
  const root = makeAcceptRepo();
  try {
    const pi = await bootAccept(root, acceptExecWith(acceptResult));
    const ctx = fakeCtx(root, { confirm: () => true });
    await pi.commands['adlc-accept'].handler('.adlc/packet.json', ctx);
    return { notices: ctx.notices, entries: pi.entries };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('AC4: /adlc-accept records the acceptance when the CLI exits 0 with no JSON on stdout', async () => {
  const { notices } = await runAccept({ stdout: 'accepted\n', stderr: '', code: 0 });
  assert.ok(
    notices.some((n) => /recorded P6 acceptance/i.test(n.msg)),
    `expected an acceptance notice, got ${JSON.stringify(notices)}`
  );
  assert.ok(!notices.some((n) => /acceptance gate FAILED/i.test(n.msg)));
});

test('AC4: /adlc-accept refuses when the CLI exits non-zero with no JSON on stdout', async () => {
  const { notices } = await runAccept({ stdout: 'nope\n', stderr: 'boom', code: 1 });
  assert.ok(
    notices.some((n) => /acceptance gate FAILED/i.test(n.msg) && /Not recorded/i.test(n.msg)),
    `expected a refusal notice, got ${JSON.stringify(notices)}`
  );
  assert.ok(!notices.some((n) => /recorded P6 acceptance/i.test(n.msg)));
});

test('AC4: /adlc-accept reports the CLI\'s structured errors, not its exit code, when it emits them', async () => {
  const { notices } = await runAccept({
    stdout: JSON.stringify({ ok: false, errors: ['no p5 evidence', 'revision drifted'] }),
    stderr: '', code: 2,
  });
  const failure = notices.find((n) => /acceptance gate FAILED/i.test(n.msg));
  assert.ok(failure, `expected a refusal notice, got ${JSON.stringify(notices)}`);
  assert.match(failure.msg, /no p5 evidence; revision drifted/);
  assert.doesNotMatch(failure.msg, /exit 2/, 'the structured errors replace the exit-code fallback');
});

test('AC4: /adlc-accept falls back to the exit code when the CLI JSON carries no error list', async () => {
  const { notices } = await runAccept({
    stdout: JSON.stringify({ ok: false }), stderr: 'boom', code: 2,
  });
  const failure = notices.find((n) => /acceptance gate FAILED/i.test(n.msg));
  assert.ok(failure, `expected a refusal notice, got ${JSON.stringify(notices)}`);
  assert.match(failure.msg, /exit 2/);
  assert.match(failure.msg, /boom/);
});

test('AC4: /adlc-accept refuses a KILLED accept exec even though it reports code 0', async () => {
  const { notices } = await runAccept({ stdout: '', stderr: '', code: 0, killed: true });
  const failure = notices.find((n) => /acceptance gate FAILED/i.test(n.msg));
  assert.ok(failure, `expected a refusal notice, got ${JSON.stringify(notices)}`);
  assert.match(failure.msg, /killed/i, 'the refusal names the kill rather than an exit code');
  assert.ok(!notices.some((n) => /recorded P6 acceptance/i.test(n.msg)));
});

// =========================================================================
// AC5 / AC6 — a prosecution in which no lens ran is INCONCLUSIVE, not CLEAN
// =========================================================================

const DIFF = '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-old\n+new\n';
const PTICKET = { id: 'T1', title: 'Test ticket' };

function finding(over = {}) {
  return {
    severity: 'high',
    file: 'src/x.mjs',
    line_start: 3,
    line_end: 5,
    title: 'off-by-one in the loop bound',
    body: 'the guard uses <= where < is correct',
    evidence: '+new',
    recommendation: 'use <',
    ...over,
  };
}

/** Every lens throws — the shape of a missing binary or absent credentials. */
async function allLensesFail(prompt) {
  if (prompt.startsWith('You are an ADLC prosecution VERIFIER')) return JSON.stringify({ real: true });
  throw new Error('spawn pi ENOENT');
}

test('AC5: every lens degraded with zero findings → INCONCLUSIVE, never CLEAN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-failclosed-inconclusive-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  try {
    const summary = await prosecute({
      diff: DIFF,
      ticket: PTICKET,
      runLens: allLensesFail,
      recordDir: join(dir, '.adlc'),
      options: { maxRounds: 1, maxDry: 1 },
      record: () => {},
    });
    assert.ok(summary.degradedLenses.length > 0, 'the failing lenses are reported degraded');
    assert.equal(summary.findings.length, 0);
    assert.equal(summary.verdict, 'INCONCLUSIVE', 'a prosecution in which no lens ran is not a clean bill of health');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC5: SOME lenses degraded with zero confirmed findings is still INCONCLUSIVE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-failclosed-partial-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  try {
    const runLens = async (prompt) => {
      if (prompt.startsWith('You are an ADLC prosecution VERIFIER')) return JSON.stringify({ real: true });
      if (prompt.includes('logic errors')) throw new Error('spawn pi ENOENT');
      return '[]';
    };
    const summary = await prosecute({
      diff: DIFF,
      ticket: PTICKET,
      runLens,
      recordDir: join(dir, '.adlc'),
      options: { maxRounds: 1, maxDry: 1 },
      record: () => {},
    });
    assert.ok(summary.degradedLenses.length > 0);
    assert.equal(summary.findings.length, 0);
    assert.equal(summary.verdict, 'INCONCLUSIVE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC5: a confirmed finding is FINDINGS even when lenses degraded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-failclosed-findings-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  try {
    const runLens = async (prompt) => {
      if (prompt.startsWith('You are an ADLC prosecution VERIFIER')) return JSON.stringify({ real: true });
      if (prompt.includes('logic errors')) throw new Error('spawn pi ENOENT');
      if (prompt.includes('security')) return JSON.stringify([finding()]);
      return '[]';
    };
    const summary = await prosecute({
      diff: DIFF,
      ticket: PTICKET,
      runLens,
      recordDir: join(dir, '.adlc'),
      options: { maxRounds: 1, maxDry: 1 },
      record: () => {},
    });
    assert.ok(summary.degradedLenses.length > 0, 'a lens still degraded');
    assert.equal(summary.findings.length, 1);
    assert.equal(summary.verdict, 'FINDINGS', 'confirmed findings outrank degradation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC5: no degradation and no findings is still CLEAN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-failclosed-clean-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  try {
    const runLens = async (prompt) => {
      if (prompt.startsWith('You are an ADLC prosecution VERIFIER')) return JSON.stringify({ real: true });
      return '[]';
    };
    const summary = await prosecute({
      diff: DIFF,
      ticket: PTICKET,
      runLens,
      recordDir: join(dir, '.adlc'),
      options: { maxRounds: 1, maxDry: 1 },
      record: () => {},
    });
    assert.equal(summary.degradedLenses.length, 0);
    assert.equal(summary.verdict, 'CLEAN');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC5: an empty diff is CLEAN — zero lenses were supposed to run, which is not degradation', async () => {
  const summary = await prosecute({
    diff: '   \n  ',
    ticket: PTICKET,
    runLens: async () => '[]',
  });
  assert.equal(summary.verdict, 'CLEAN');
  assert.equal(summary.degradedLenses.length, 0);
});

test('AC6: renderSummary for INCONCLUSIVE never reads as a clean bill of health', () => {
  const text = renderSummary({
    verdict: 'INCONCLUSIVE',
    rounds: 1,
    dryPasses: 1,
    findings: [],
    degradedLenses: [{ lens: 'correctness', round: 1, reason: 'spawn pi ENOENT' }],
    models: [],
  });
  assert.match(text, /INCONCLUSIVE/);
  assert.doesNotMatch(text.split('\n')[0], /CLEAN/, 'the header must not claim CLEAN');
  assert.doesNotMatch(
    text,
    /^No confirmed findings survived verification\.$/m,
    'the bare no-findings line reads as a pass — an INCONCLUSIVE run must say no lens result was obtained'
  );
  assert.match(text, /Degraded lenses \(not counted as clean\)/);
});

test('AC6: renderSummary for a genuine CLEAN run is unchanged', () => {
  const text = renderSummary({
    verdict: 'CLEAN', rounds: 2, dryPasses: 2, findings: [], degradedLenses: [], models: [],
  });
  assert.match(text.split('\n')[0], /^ADLC prosecution: CLEAN \(2 rounds, 2 dry passes\)$/);
  assert.match(text, /^No confirmed findings survived verification\.$/m);
});
