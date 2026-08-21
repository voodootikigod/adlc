// cc-helper-drift.test.mjs — pin the Claude Code hook's two retained pure
// helpers to this package's canonical implementations (slice 5).
//
// plugins/adlc-claude-code/hooks/handoff-gate.mjs keeps its own
// `resolveSessionId` / `isProtectedHandoffPath` because that module is loaded
// synchronously by the hook while the package can only be resolved
// asynchronously (no workspace node_modules in a plugin install dir; Node 18
// cannot `require()` an ESM package). The hook's real decisions go through the
// package, but the frozen slice-4 contract test drives these two directly — so
// they must not be allowed to drift from the copies they mirror. Same pattern
// as packages/core/test/shell.test.mjs pinning the Codex hook's inline shell
// classifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isSafeSessionId,
  resolveHandoffSessionId,
  isProtectedHandoffPath as canonicalIsProtectedHandoffPath,
  isBareInspectionPwd as canonicalIsBareInspectionPwd,
  matchRecoveryCommand as canonicalMatchRecoveryCommand,
  formatRecoveryCommand as canonicalFormatRecoveryCommand,
  formatNoSessionIdMessage as canonicalFormatNoSessionIdMessage,
  formatUnsafeInstallPathMessage as canonicalFormatUnsafeInstallPathMessage,
  readBypassGrant as canonicalReadBypassGrant,
  writeBypassGrant,
  bypassGrantPath,
  BYPASS_GRANT_SCHEMA,
  CAPTURE_INSTRUCTION as canonicalCaptureInstruction,
  buildBootstrapPrompt,
} from '@adlc/context-handoff';
import { canonicalJson } from '@adlc/core';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CC_HANDOFF_GATE = join(
  REPO_ROOT,
  'plugins',
  'adlc-claude-code',
  'hooks',
  'handoff-gate.mjs',
);

const CC_HOOK = join(REPO_ROOT, 'plugins', 'adlc-claude-code', 'hooks', 'adlc-hook.mjs');

const {
  resolveSessionId: ccResolveSessionId,
  isProtectedHandoffPath: ccIsProtectedHandoffPath,
  CAPTURE_INSTRUCTION: ccCaptureInstruction,
  readVerifiedBypassGrant: ccReadVerifiedBypassGrant,
  isBareInspectionPwd: ccIsBareInspectionPwd,
  matchRecoveryCommand: ccMatchRecoveryCommand,
  isSafeSessionId: ccIsSafeSessionId,
  formatRecoveryCommand: ccFormatRecoveryCommand,
  formatNoSessionIdMessage: ccFormatNoSessionIdMessage,
  formatUnsafeInstallPathMessage: ccFormatUnsafeInstallPathMessage,
} = await import(CC_HANDOFF_GATE);

/** Payload shapes the two session resolvers must agree on. */
const SESSION_CASES = [
  null,
  undefined,
  {},
  { session_id: 'sess-a' },
  { sessionId: 'sess-b' },
  { session_id: 'sess-a', sessionId: 'sess-b' },
  { session_id: '', sessionId: 'sess-b' },
  { session_id: '', transcript_path: '' },
  { transcript_path: '/tmp/uuid-1.jsonl' },
  { transcript_path: '/tmp/uuid-1' },
  { transcript_path: '....jsonl' },
  { transcript_path: 12 },
  { session_id: 'sess-a', transcript_path: '/tmp/uuid-1.jsonl' },
  { session_id: '../escape' },
  { session_id: 'has/slash' },
];

/** Repo-relative paths the two path guards must agree on. */
const PATH_CASES = [
  '',
  'src/app.mjs',
  '.adlc/tickets.json',
  '.adlc/.deny-store',
  '.adlc/handoffs/.deny-store',
  '.adlc/handoffs/denies',
  '.adlc/handoffs/denies/sess-a.json',
  './.adlc/handoffs/denies/sess-a.json',
  '.adlc/handoffs/x/../denies/sess-a.json',
  // Capture bodies. The fixed list above predates `.adlc/handoffs/content/**`,
  // so the CC copy went on returning false for every one of these while the
  // canonical returned true and this test still passed — the exact drift it
  // exists to catch, invisible because no case named the directory.
  '.adlc/handoffs/content',
  '.adlc/handoffs/content/sess-a.md',
  './.adlc/handoffs/content/sess-a.md',
  '.adlc/handoffs/x/../content/sess-a.md',
  '.adlc\\handoffs\\content\\sess-a.md',
  '.adlc/handoffs/content-other/sess-a.md',
  '.adlc/handoffs/sess-a.resume-auth.json',
  '.adlc/handoffs/sess-a.model-ok',
  '.adlc/handoffs/sess-a.lock',
  '.adlc/handoffs/sess-a.bypass-grant.json',
  './.adlc/handoffs/x/../sess-a.bypass-grant.json',
  '.adlc/handoffs/final.md',
  '.adlc/handoffs-other/denies/x.json',
  '.adlc\\handoffs\\denies\\sess-a.json',
];

test('the CC session resolver agrees with resolveHandoffSessionId', () => {
  for (const input of SESSION_CASES) {
    const cc = ccResolveSessionId(input, { isSafeSessionId });
    const payload = input && typeof input === 'object' ? input : {};
    const canonical = resolveHandoffSessionId({
      candidates: [payload.session_id, payload.sessionId],
      transcriptPath: payload.transcript_path,
    });
    assert.equal(cc, canonical, `drift on ${JSON.stringify(input)}`);
  }
});

test('the CC path guard agrees with isProtectedHandoffPath', () => {
  for (const p of PATH_CASES) {
    assert.equal(
      ccIsProtectedHandoffPath(p),
      canonicalIsProtectedHandoffPath(p),
      `drift on ${JSON.stringify(p)}`,
    );
  }
});

test('the path drift cases straddle the verdict boundary', () => {
  // Same guard as the grant table below: two twins that both returned a
  // constant would agree on every case above and prove nothing.
  const verdicts = PATH_CASES.map((p) => canonicalIsProtectedHandoffPath(p));
  assert.ok(verdicts.includes(true), 'no case is protected');
  assert.ok(verdicts.includes(false), 'no case is unprotected');
  assert.equal(canonicalIsProtectedHandoffPath('.adlc/handoffs/content/sess-a.md'), true);
  assert.equal(canonicalIsProtectedHandoffPath('.adlc/handoffs/content-other/sess-a.md'), false);
});

test('the keyless hedge the CC hook depends on is part of the prompt contract', () => {
  // The hook capability-checks that `buildBootstrapPrompt` EXISTS, but its
  // honesty guarantee rests on the resolved package HONORING `verified`. A copy
  // that silently ignored the option would emit the assertive "continue the
  // work" text from a keyless hook — the exact false claim the trust-boundary
  // ruling removed — and every capability check would still pass.
  const inputs = { denySessionId: 'sess-a', ticketId: 'T-1', body: 'BODY' };
  const hedged = buildBootstrapPrompt({ ...inputs, verified: false });
  const assertive = buildBootstrapPrompt(inputs);

  assert.equal(hedged.ok, true);
  assert.equal(assertive.ok, true);
  assert.match(hedged.prompt, /NOT VERIFIED/);
  assert.match(hedged.prompt, /not cryptographically verified by this keyless hook/);
  assert.match(hedged.prompt, /^Possible continuation of session sess-a/);

  // The supervised form keeps the claim it has earned.
  assert.doesNotMatch(assertive.prompt, /NOT VERIFIED/);
  assert.match(assertive.prompt, /^Continuation of session sess-a/);

  // The single assertion that catches an option-ignoring package.
  assert.notEqual(
    hedged.prompt,
    assertive.prompt,
    'a package that ignores `verified` returns identical text and the keyless hook then lies',
  );
  // Both forms keep the fence — one composition, so it cannot drift.
  for (const built of [hedged, assertive]) {
    assert.ok(built.prompt.includes('<<<UNTRUSTED-CAPTURE-DATA'));
    assert.ok(built.prompt.includes('END-UNTRUSTED>>>'));
  }

  // And the hook must actually ask for the hedged form.
  assert.match(
    readFileSync(CC_HOOK, 'utf8'),
    /verified: false/,
    'the SessionStart hook must pass the hedge flag',
  );
});

test('the CC deny message carries the canonical capture instruction', () => {
  // The hook keeps its own copy so a project-resolved package cannot delete the
  // one sentence that makes a denied session's final message worth capturing.
  assert.equal(ccCaptureInstruction, canonicalCaptureInstruction);
  assert.match(ccCaptureInstruction, /handoff summary/);
});


test('the CC bare-pwd exception agrees with isBareInspectionPwd', () => {
  for (const cmd of ['pwd', 'pwd -L', ' pwd', 'pwd ', 'pwd; ls', '', null, undefined]) {
    assert.equal(
      ccIsBareInspectionPwd(cmd),
      canonicalIsBareInspectionPwd(cmd),
      `drift on ${JSON.stringify(cmd)}`,
    );
  }
});

test('the CC recovery matcher agrees with matchRecoveryCommand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-helper-drift-'));
  // A separate, SPACE-containing dir — this is the fixture that caught a
  // real drift bug (round 1 of this ticket's own review): the local copies
  // had `inner.includes(' ')` where the canonical has `inner.includes('\0')`,
  // silently rejecting every legitimate quoted spaced path. Never drop this
  // case from the drift table.
  const spacedDir = mkdtempSync(join(tmpdir(), 'cc-helper-drift space '));
  try {
    const interpreterPath = join(dir, 'node');
    const scriptPath = join(dir, 'handoff.mjs');
    writeFileSync(interpreterPath, '');
    writeFileSync(scriptPath, '');
    const spacedInterpreterPath = join(spacedDir, 'node');
    const spacedScriptPath = join(spacedDir, 'handoff.mjs');
    writeFileSync(spacedInterpreterPath, '');
    writeFileSync(spacedScriptPath, '');
    const sessionId = 'sess-a';
    const opts = { interpreterPath, scriptPath, sessionId };
    const spacedOpts = { interpreterPath: spacedInterpreterPath, scriptPath: spacedScriptPath, sessionId };
    const cases = [
      [`${interpreterPath} ${scriptPath} bypass --session ${sessionId} --write`, opts],
      [`${interpreterPath} ${scriptPath} unlock --session ${sessionId} --started-at 2026-08-15T12:34:56.789Z --write`, opts],
      [`${interpreterPath} ${scriptPath} resume --session ${sessionId} --deny-session other-session --write`, opts],
      [`${interpreterPath} ${scriptPath} bypass --session other-session --write`, opts], // wrong session
      [`${interpreterPath} ${scriptPath} bypass --session ${sessionId} --write; rm -rf /`, opts], // decoy
      [`node ${scriptPath} bypass --session ${sessionId} --write`, opts], // bare interpreter
      [`${interpreterPath} ${scriptPath} frobnicate --session ${sessionId} --write`, opts], // unknown subcommand
      [`'${spacedInterpreterPath}' '${spacedScriptPath}' bypass --session ${sessionId} --write`, spacedOpts], // quoted spaced path
      ['pwd', opts],
      ['', opts],
    ];
    for (const [cmd, o] of cases) {
      const cc = ccMatchRecoveryCommand(cmd, o);
      const canonical = canonicalMatchRecoveryCommand(cmd, o);
      assert.deepEqual(cc, canonical, `drift on ${JSON.stringify(cmd)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(spacedDir, { recursive: true, force: true });
  }
});

test('the CC recovery diagnostic formatters agree with the canonical formatters (Round-5 Finding 4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-helper-drift-format-'));
  const apostropheDir = mkdtempSync(join(tmpdir(), "cc-helper-drift-format-o'clock-"));
  try {
    const interpreterPath = join(dir, 'node');
    const scriptPath = join(dir, 'handoff.mjs');
    const apostropheScriptPath = join(apostropheDir, 'handoff.mjs');
    const cases = [
      { interpreterPath, scriptPath, sessionId: 'sess-a' },
      { interpreterPath, scriptPath, sessionId: null },
      { interpreterPath, scriptPath, sessionId: '' },
      { interpreterPath, scriptPath, sessionId: 'has a space' }, // fails VALUE_GRAMMAR
      { interpreterPath, scriptPath: apostropheScriptPath, sessionId: 'sess-a' }, // unquotable path
    ];
    for (const o of cases) {
      assert.equal(ccFormatRecoveryCommand(o), canonicalFormatRecoveryCommand(o), `drift on ${JSON.stringify(o)}`);
    }
    assert.equal(ccFormatNoSessionIdMessage(), canonicalFormatNoSessionIdMessage());
    const unsafeOpts = { interpreterPath, scriptPath: apostropheScriptPath, sessionId: 'sess-a' };
    assert.equal(ccFormatUnsafeInstallPathMessage(unsafeOpts), canonicalFormatUnsafeInstallPathMessage(unsafeOpts));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(apostropheDir, { recursive: true, force: true });
  }
});

test('the CC isSafeSessionId agrees with the canonical isSafeSessionId', () => {
  for (const id of ['sess-a', '', null, undefined, '../escape', 'has/slash', '  padded  ', 'a'.repeat(200)]) {
    assert.equal(ccIsSafeSessionId(id), isSafeSessionId(id), `drift on ${JSON.stringify(id)}`);
  }
});

test('the case tables actually exercise both verdicts', () => {
  // A drift test whose inputs all land on one verdict would pass against a
  // helper that returned a constant. Prove both tables straddle the boundary.
  const sessions = SESSION_CASES.map((i) => ccResolveSessionId(i, { isSafeSessionId }));
  assert.ok(sessions.some((s) => s !== null), 'no case resolves a session id');
  assert.ok(sessions.some((s) => s === null), 'no case rejects a session id');

  const paths = PATH_CASES.map((p) => ccIsProtectedHandoffPath(p));
  assert.ok(paths.some(Boolean), 'no case is protected');
  assert.ok(paths.some((v) => !v), 'no case is unprotected');
});

// ---------------------------------------------------------------------------
// readVerifiedBypassGrant — the hook's trusted grant-verification twin
// ("KEEP IN SYNC (3)" in handoff-gate.mjs). The hook verifies the grant
// itself, pre-secret-scrub, so ADLC_MANIFEST_KEY never reaches the
// project-resolved package; this pin keeps that twin honest against the
// canonical readBypassGrant across every verdict-relevant fixture shape.

const GRANT_KEY = 'k'.repeat(64);
const WRONG_KEY = 'w'.repeat(64);

/** Build one fixture repo per case; returns [name, mutate(root), readOpts]. */
const GRANT_CASES = [
  ['valid grant, right key', (root) => writeBypassGrant(root, 'sess-a', {}, { key: GRANT_KEY }), { key: GRANT_KEY }],
  ['valid grant, wrong key', (root) => writeBypassGrant(root, 'sess-a', {}, { key: WRONG_KEY }), { key: GRANT_KEY }],
  ['valid grant, no key', (root) => writeBypassGrant(root, 'sess-a', {}, { key: GRANT_KEY }), {}],
  ['valid grant with unbound_reason', (root) => writeBypassGrant(root, 'sess-a', { unboundReason: 'no ticket' }, { key: GRANT_KEY }), { key: GRANT_KEY }],
  ['missing file', () => {}, { key: GRANT_KEY }],
  [
    'session_id inside the file names another session',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      const fields = { session_id: 'sess-b', unbound_reason: null, written_at: new Date().toISOString() };
      const sig = createHmac('sha256', GRANT_KEY).update(canonicalJson({ schema: BYPASS_GRANT_SCHEMA, ...fields })).digest('hex');
      writeFileSync(bypassGrantPath(root, 'sess-a'), JSON.stringify({ schema: BYPASS_GRANT_SCHEMA, ...fields, sig }));
    },
    { key: GRANT_KEY },
  ],
  [
    'validly-signed but past TTL',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      const fields = { session_id: 'sess-a', unbound_reason: null, written_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
      const sig = createHmac('sha256', GRANT_KEY).update(canonicalJson({ schema: BYPASS_GRANT_SCHEMA, ...fields })).digest('hex');
      writeFileSync(bypassGrantPath(root, 'sess-a'), JSON.stringify({ schema: BYPASS_GRANT_SCHEMA, ...fields, sig }));
    },
    { key: GRANT_KEY },
  ],
  [
    'tampered written_at (sig no longer covers it)',
    (root) => {
      writeBypassGrant(root, 'sess-a', {}, { key: GRANT_KEY });
      const p = bypassGrantPath(root, 'sess-a');
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      doc.written_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      writeFileSync(p, JSON.stringify(doc));
    },
    { key: GRANT_KEY },
  ],
  [
    // TTL boundary pin: 10.5 minutes old sits between the real 10-minute TTL
    // and an off-by-one 11-minute mutant of the twin's local constant — with
    // only far-past/fresh fixtures both sides agree under either TTL and the
    // mutant survives. Deterministic via the injected `now`.
    'validly-signed, 10.5 minutes old (straddles the TTL boundary)',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      const fields = { session_id: 'sess-a', unbound_reason: null, written_at: '2026-01-01T00:00:00.000Z' };
      const sig = createHmac('sha256', GRANT_KEY).update(canonicalJson({ schema: BYPASS_GRANT_SCHEMA, ...fields })).digest('hex');
      writeFileSync(bypassGrantPath(root, 'sess-a'), JSON.stringify({ schema: BYPASS_GRANT_SCHEMA, ...fields, sig }));
    },
    { key: GRANT_KEY, now: () => Date.parse('2026-01-01T00:00:00.000Z') + Math.round(10.5 * 60 * 1000) },
  ],
  [
    'legacy schema-1 document',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      const fields = { session_id: 'sess-a', unbound_reason: null };
      const sig = createHmac('sha256', GRANT_KEY).update(canonicalJson({ schema: 1, ...fields })).digest('hex');
      writeFileSync(bypassGrantPath(root, 'sess-a'), JSON.stringify({ schema: 1, ...fields, written_at: new Date().toISOString(), sig }));
    },
    { key: GRANT_KEY },
  ],
  [
    'corrupt JSON',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      writeFileSync(bypassGrantPath(root, 'sess-a'), '{not json');
    },
    { key: GRANT_KEY },
  ],
  [
    // Parses fine but is not an object — and `typeof null === 'object'`, so a
    // shape guard whose || decays to && lets JSON null through to a property
    // access (throw) instead of reading as absent. Must agree with the
    // canonical's invalid_shape rejection, never crash.
    'file contains the JSON literal null',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      writeFileSync(bypassGrantPath(root, 'sess-a'), 'null');
    },
    { key: GRANT_KEY },
  ],
  [
    'file contains a JSON array',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      writeFileSync(bypassGrantPath(root, 'sess-a'), '[1,2]');
    },
    { key: GRANT_KEY },
  ],
  [
    // Round-13 review: a valid, correctly-signed grant that exceeds
    // MAX_BYPASS_GRANT_BYTES — padding lives inside unbound_reason so the
    // document otherwise parses and would verify if size weren't checked.
    'validly-signed but exceeds MAX_BYPASS_GRANT_BYTES',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      const fields = { session_id: 'sess-a', unbound_reason: 'x'.repeat(5000), written_at: new Date().toISOString() };
      const sig = createHmac('sha256', GRANT_KEY).update(canonicalJson({ schema: BYPASS_GRANT_SCHEMA, ...fields })).digest('hex');
      writeFileSync(bypassGrantPath(root, 'sess-a'), JSON.stringify({ schema: BYPASS_GRANT_SCHEMA, ...fields, sig }));
    },
    { key: GRANT_KEY },
  ],
  [
    // Round-13 review: a symlink at the grant path pointing at an otherwise
    // validly-signed grant file elsewhere. lstat (never follows) must reject
    // it outright, not read through to the valid target.
    'grant path is a symlink to a valid grant elsewhere',
    (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      const real = join(root, 'real-grant.json');
      const fields = { session_id: 'sess-a', unbound_reason: null, written_at: new Date().toISOString() };
      const sig = createHmac('sha256', GRANT_KEY).update(canonicalJson({ schema: BYPASS_GRANT_SCHEMA, ...fields })).digest('hex');
      writeFileSync(real, JSON.stringify({ schema: BYPASS_GRANT_SCHEMA, ...fields, sig }));
      symlinkSync(real, bypassGrantPath(root, 'sess-a'));
    },
    { key: GRANT_KEY },
  ],
];

test('the CC readVerifiedBypassGrant agrees with the canonical readBypassGrant', () => {
  for (const [name, mutate, readOpts] of GRANT_CASES) {
    const root = mkdtempSync(join(tmpdir(), 'cc-grant-drift-'));
    try {
      mkdirSync(join(root, '.adlc'), { recursive: true });
      mutate(root);
      const canonical = canonicalReadBypassGrant(root, 'sess-a', readOpts);
      const twin = ccReadVerifiedBypassGrant(root, 'sess-a', readOpts);
      assert.deepEqual(twin, canonical, `drift on ${name}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the CC grant twin returns null (never throws) on an unsafe session id', () => {
  // Deliberate, documented divergence: the canonical asserts on an unsafe id
  // (bypassGrantPath -> assertSafeSessionId); the hook twin must never crash
  // on hostile input, so it reads as absent instead.
  const root = mkdtempSync(join(tmpdir(), 'cc-grant-unsafe-'));
  try {
    for (const bad of ['../escape', 'has/slash', '', null, undefined]) {
      assert.equal(ccReadVerifiedBypassGrant(root, bad, { key: GRANT_KEY }), null, `must be null for ${JSON.stringify(bad)}`);
    }
    assert.throws(() => canonicalReadBypassGrant(root, '../escape', { key: GRANT_KEY }), /session/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the grant drift cases straddle the verdict boundary', () => {
  // Same guard as the tables above: a twin returning a constant must fail.
  const verdicts = GRANT_CASES.map(([, mutate, readOpts]) => {
    const root = mkdtempSync(join(tmpdir(), 'cc-grant-verdicts-'));
    try {
      mkdirSync(join(root, '.adlc'), { recursive: true });
      mutate(root);
      return ccReadVerifiedBypassGrant(root, 'sess-a', readOpts);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  assert.ok(verdicts.some((v) => v && v.verified === true), 'no case verifies');
  assert.ok(verdicts.some((v) => v && v.verified === false), 'no case reads-but-fails-verification');
  assert.ok(verdicts.some((v) => v === null), 'no case reads as absent');
});
