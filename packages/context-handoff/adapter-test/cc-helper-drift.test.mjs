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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
} from '@adlc/context-handoff';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CC_HANDOFF_GATE = join(
  REPO_ROOT,
  'plugins',
  'adlc-claude-code',
  'hooks',
  'handoff-gate.mjs',
);

const {
  resolveSessionId: ccResolveSessionId,
  isProtectedHandoffPath: ccIsProtectedHandoffPath,
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
  '.adlc/handoffs/sess-a.resume-auth.json',
  '.adlc/handoffs/sess-a.model-ok',
  '.adlc/handoffs/sess-a.lock',
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
