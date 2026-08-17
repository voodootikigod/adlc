// codex-helper-drift.test.mjs — pin the Codex hook's trusted local Recovery
// Exception / Inspection Bash Exception copy to this package's canonical
// implementation (Phase 0 hotfix, context-rot-threshold-calibration spec
// §1.3, AC0).
//
// plugins/adlc-codex/hooks/adlc-handoff-gate.mjs keeps its own
// `isBareInspectionPwd` / `matchRecoveryCommand` — see that file's own
// "KEEP IN SYNC" comment for why: these gate the operator's escape hatch out
// of a Hard-Degraded session and must not depend on the project-resolved
// `@adlc/context-handoff` package successfully loading. Same pattern as
// packages/context-handoff/adapter-test/cc-helper-drift.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

import {
  isBareInspectionPwd as canonicalIsBareInspectionPwd,
  matchRecoveryCommand as canonicalMatchRecoveryCommand,
  isSafeSessionId,
  resolveHandoffSessionId,
  formatRecoveryCommand as canonicalFormatRecoveryCommand,
  formatNoSessionIdMessage as canonicalFormatNoSessionIdMessage,
  formatUnsafeInstallPathMessage as canonicalFormatUnsafeInstallPathMessage,
  readBypassGrant as canonicalReadBypassGrant,
  writeBypassGrant,
  bypassGrantPath,
  BYPASS_GRANT_SCHEMA,
} from '@adlc/context-handoff';
import { canonicalJson } from '@adlc/core';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CODEX_HANDOFF_GATE = join(REPO_ROOT, 'plugins', 'adlc-codex', 'hooks', 'adlc-handoff-gate.mjs');

const {
  isBareInspectionPwd: codexIsBareInspectionPwd,
  matchRecoveryCommand: codexMatchRecoveryCommand,
  isSafeSessionId: codexIsSafeSessionId,
  resolveHandoffSessionIdLocal: codexResolveHandoffSessionId,
  formatRecoveryCommand: codexFormatRecoveryCommand,
  formatNoSessionIdMessage: codexFormatNoSessionIdMessage,
  formatUnsafeInstallPathMessage: codexFormatUnsafeInstallPathMessage,
  readVerifiedBypassGrant: codexReadVerifiedBypassGrant,
} = await import(CODEX_HANDOFF_GATE);

test('the Codex bare-pwd exception agrees with isBareInspectionPwd', () => {
  for (const cmd of ['pwd', 'pwd -L', ' pwd', 'pwd ', 'pwd; ls', '', null, undefined]) {
    assert.equal(
      codexIsBareInspectionPwd(cmd),
      canonicalIsBareInspectionPwd(cmd),
      `drift on ${JSON.stringify(cmd)}`,
    );
  }
});

test('the Codex recovery matcher agrees with matchRecoveryCommand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-helper-drift-'));
  // A separate, SPACE-containing dir — this is the fixture that caught a
  // real drift bug (round 1 of this ticket's own review): the local copies
  // had `inner.includes(' ')` where the canonical has `inner.includes('\0')`,
  // silently rejecting every legitimate quoted spaced path. Never drop this
  // case from the drift table.
  const spacedDir = mkdtempSync(join(tmpdir(), 'codex-helper-drift space '));
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
      [`${interpreterPath} ${scriptPath} bypass --session other-session --write`, opts],
      [`${interpreterPath} ${scriptPath} bypass --session ${sessionId} --write; rm -rf /`, opts],
      [`node ${scriptPath} bypass --session ${sessionId} --write`, opts],
      [`${interpreterPath} ${scriptPath} frobnicate --session ${sessionId} --write`, opts],
      [`'${spacedInterpreterPath}' '${spacedScriptPath}' bypass --session ${sessionId} --write`, spacedOpts],
      ['pwd', opts],
      ['', opts],
    ];
    for (const [cmd, o] of cases) {
      const codex = codexMatchRecoveryCommand(cmd, o);
      const canonical = canonicalMatchRecoveryCommand(cmd, o);
      assert.deepEqual(codex, canonical, `drift on ${JSON.stringify(cmd)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(spacedDir, { recursive: true, force: true });
  }
});

test('the Codex recovery diagnostic formatters agree with the canonical formatters (Round-5 Finding 4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-helper-drift-format-'));
  const apostropheDir = mkdtempSync(join(tmpdir(), "codex-helper-drift-format-o'clock-"));
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
      assert.equal(codexFormatRecoveryCommand(o), canonicalFormatRecoveryCommand(o), `drift on ${JSON.stringify(o)}`);
    }
    assert.equal(codexFormatNoSessionIdMessage(), canonicalFormatNoSessionIdMessage());
    const unsafeOpts = { interpreterPath, scriptPath: apostropheScriptPath, sessionId: 'sess-a' };
    assert.equal(codexFormatUnsafeInstallPathMessage(unsafeOpts), canonicalFormatUnsafeInstallPathMessage(unsafeOpts));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(apostropheDir, { recursive: true, force: true });
  }
});

test('the Codex isSafeSessionId agrees with the canonical isSafeSessionId', () => {
  for (const id of ['sess-a', '', null, undefined, '../escape', 'has/slash', '  padded  ', 'a'.repeat(200)]) {
    assert.equal(codexIsSafeSessionId(id), isSafeSessionId(id), `drift on ${JSON.stringify(id)}`);
  }
});

test('the Codex session resolver agrees with resolveHandoffSessionId', () => {
  const cases = [
    { candidates: ['sess-a', 'sess-b'] },
    { candidates: [undefined, '', 'sess-b'] },
    { candidates: [null], transcriptPath: '/tmp/uuid-1.jsonl' },
    {},
    { transcriptPath: '' },
  ];
  for (const c of cases) {
    assert.equal(
      codexResolveHandoffSessionId(c),
      resolveHandoffSessionId(c),
      `drift on ${JSON.stringify(c)}`,
    );
  }
});

test('the case tables actually exercise both verdicts', () => {
  const pwdCases = ['pwd', 'pwd -L', ' pwd', 'pwd ', 'pwd; ls', ''];
  const results = pwdCases.map((c) => codexIsBareInspectionPwd(c));
  assert.ok(results.some(Boolean), 'no case is the bare exception');
  assert.ok(results.some((v) => !v), 'no case is rejected');
});

// ---------------------------------------------------------------------------
// readVerifiedBypassGrant — the Codex hook's trusted grant-verification twin
// (see its own comment in adlc-handoff-gate.mjs). The hook verifies the grant
// itself from the pre-scrub env snapshot, so ADLC_MANIFEST_KEY never reaches
// the project-resolved package; this pin keeps that twin honest against the
// canonical readBypassGrant across every verdict-relevant fixture shape.
// Same case matrix as cc-helper-drift.test.mjs's — the two hook twins are
// themselves verbatim copies of each other.

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

test('the Codex readVerifiedBypassGrant agrees with the canonical readBypassGrant', () => {
  for (const [name, mutate, readOpts] of GRANT_CASES) {
    const root = mkdtempSync(join(tmpdir(), 'codex-grant-drift-'));
    try {
      mkdirSync(join(root, '.adlc'), { recursive: true });
      mutate(root);
      const canonical = canonicalReadBypassGrant(root, 'sess-a', readOpts);
      const twin = codexReadVerifiedBypassGrant(root, 'sess-a', readOpts);
      assert.deepEqual(twin, canonical, `drift on ${name}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the Codex grant twin returns null (never throws) on an unsafe session id', () => {
  // Deliberate, documented divergence: the canonical asserts on an unsafe id
  // (bypassGrantPath -> assertSafeSessionId); the hook twin must never crash
  // on hostile input, so it reads as absent instead.
  const root = mkdtempSync(join(tmpdir(), 'codex-grant-unsafe-'));
  try {
    for (const bad of ['../escape', 'has/slash', '', null, undefined]) {
      assert.equal(codexReadVerifiedBypassGrant(root, bad, { key: GRANT_KEY }), null, `must be null for ${JSON.stringify(bad)}`);
    }
    assert.throws(() => canonicalReadBypassGrant(root, '../escape', { key: GRANT_KEY }), /session/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the grant drift cases straddle the verdict boundary', () => {
  // Same guard as the tables above: a twin returning a constant must fail.
  const verdicts = GRANT_CASES.map(([, mutate, readOpts]) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-grant-verdicts-'));
    try {
      mkdirSync(join(root, '.adlc'), { recursive: true });
      mutate(root);
      return codexReadVerifiedBypassGrant(root, 'sess-a', readOpts);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  assert.ok(verdicts.some((v) => v && v.verified === true), 'no case verifies');
  assert.ok(verdicts.some((v) => v && v.verified === false), 'no case reads-but-fails-verification');
  assert.ok(verdicts.some((v) => v === null), 'no case reads as absent');
});
