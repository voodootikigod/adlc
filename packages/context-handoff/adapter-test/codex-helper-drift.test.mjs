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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isBareInspectionPwd as canonicalIsBareInspectionPwd,
  matchRecoveryCommand as canonicalMatchRecoveryCommand,
  isSafeSessionId,
  resolveHandoffSessionId,
  formatRecoveryCommand as canonicalFormatRecoveryCommand,
  formatNoSessionIdMessage as canonicalFormatNoSessionIdMessage,
  formatUnsafeInstallPathMessage as canonicalFormatUnsafeInstallPathMessage,
} from '@adlc/context-handoff';

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
