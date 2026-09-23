// build-gate-space-path.test.mjs — Round-5 review: adlc-build-gate.mjs's
// direct-execution guard built a `file://` URL manually
// (`file://${process.argv[1]}`) instead of using `pathToFileURL(...).href`.
// Node percent-encodes import.meta.url (a space becomes %20) but a manual
// template string does not, so ANY install path containing a space made the
// comparison always false — main() silently never ran and the hook exited 0
// (allow) unconditionally, regardless of ticket risk or session degradation.
// This is a genuine subprocess test: it copies the real hook directory to a
// space-containing path and executes THAT copy, because the bug depends on
// process.argv[1]'s actual on-disk path, not on any fixture cwd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { runHook } from './helpers/run-hook.mjs';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

function setupHighRiskDegradedRepo(root) {
  mkdirSync(join(root, '.adlc'), { recursive: true });
  const ticket = { id: 'T1', title: 'high risk', body: 'y', risk: 'high', scope: ['src/**'] };
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  const line = JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'apply_patch' }] });
  const transcriptPath = join(root, 'oversized.jsonl');
  writeFileSync(transcriptPath, `${line}\n`.repeat(50));
  return transcriptPath;
}

test('adlc-build-gate.mjs still enforces (denies) a high-risk degraded session when its OWN install path contains a space', (t) => {
  // Copy the whole hooks directory (not just the one file) — the hook
  // imports several sibling modules at its own relative paths.
  //
  // tmp(t, ...) handles realpathSync and registers cleanup via t.after.
  const spaceBase = tmp(t, 'adlc-build-gate-space-base-');
  const spaceRoot = join(spaceBase, 'adlc build gate space');
  mkdirSync(spaceRoot, { recursive: true });
  const repoRoot = tmp(t, 'adlc-build-gate-space-repo-');
  const hooksCopy = join(spaceRoot, 'hooks');
  cpSync(HOOKS_DIR, hooksCopy, { recursive: true });
  const hookCopyPath = join(hooksCopy, 'adlc-build-gate.mjs');

  const transcriptPath = setupHighRiskDegradedRepo(repoRoot);

  const env = {
    ...process.env,
    NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
  };
  const payload = { tool_name: 'apply_patch', transcript_path: transcriptPath, file_path: join(repoRoot, 'src', 'app.mjs') };

  // Copilot's verified deny shape is a non-empty {"reason": ...} object on
  // STDOUT with exit 0 — exit 2 is NOT honored by the Copilot CLI (see
  // emitDeny's own comment in adlc-build-gate.mjs). A true allow is exit 0
  // with EMPTY stdout. Both cases exit 0, so stdout content — not exit
  // code — is what distinguishes "denied" from "silently never ran".
  const stdout = runHook([hookCopyPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // A high-risk ticket at HARD_DEPTH (50 tool calls, well past the 40
  // threshold) MUST be denied. Before the fix, main() silently never ran
  // from a space-containing path and stdout stayed empty (allow).
  assert.notEqual(stdout.trim(), '', 'expected a non-empty deny reason on stdout from a space-containing install path');
  const parsed = JSON.parse(stdout);
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /high-risk/);
});
