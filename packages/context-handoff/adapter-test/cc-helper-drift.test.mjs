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

import {
  isSafeSessionId,
  resolveHandoffSessionId,
  isProtectedHandoffPath as canonicalIsProtectedHandoffPath,
} from '@adlc/context-handoff';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CC_HANDOFF_GATE = join(
  REPO_ROOT,
  'plugins',
  'adlc-claude-code',
  'hooks',
  'handoff-gate.mjs',
);

const { resolveSessionId: ccResolveSessionId, isProtectedHandoffPath: ccIsProtectedHandoffPath } =
  await import(CC_HANDOFF_GATE);

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
