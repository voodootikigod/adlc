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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

test('adlc-build-gate.mjs still enforces (denies) a high-risk degraded session when its OWN install path contains a space', () => {
  // Copy the whole hooks directory (not just the one file) — the hook
  // imports several sibling modules at its own relative paths.
  //
  // realpathSync the mkdtemp base BEFORE appending the space-containing
  // segment: on macOS, os.tmpdir() is under /tmp, itself a symlink to
  // /private/tmp. import.meta.url reports the REALPATH-resolved location,
  // so comparing it against a path built from the UNRESOLVED /tmp/... alias
  // would report "not equal" for a reason that has nothing to do with this
  // test's actual subject (space-encoding) — the exact class of false
  // failure this repo's own prior sessions have hit before. Resolving the
  // base once, then adding the space segment UNDER the resolved path, keeps
  // both sides of the real isMain comparison consistent.
  const spaceBase = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-build-gate-space-base-')));
  const spaceRoot = join(spaceBase, 'adlc build gate space');
  mkdirSync(spaceRoot, { recursive: true });
  const repoRoot = mkdtempSync(join(tmpdir(), 'adlc-build-gate-space-repo-'));
  try {
    const hooksCopy = join(spaceRoot, 'hooks');
    cpSync(HOOKS_DIR, hooksCopy, { recursive: true });
    const hookCopyPath = join(hooksCopy, 'adlc-build-gate.mjs');

    const transcriptPath = setupHighRiskDegradedRepo(repoRoot);

    const env = {
      ...process.env,
      NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
    };
    const payload = { tool_name: 'apply_patch', transcript_path: transcriptPath, file_path: join(repoRoot, 'src', 'app.mjs') };

    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [hookCopyPath], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: repoRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status ?? 1;
      stderr = e.stderr ?? '';
    }

    // A high-risk ticket at HARD_DEPTH (50 tool calls, well past the 40
    // threshold) MUST be denied (status 2). Before the fix, main() silently
    // never ran from a space-containing path and the process exited 0.
    assert.equal(status, 2, `expected deny (status 2) from a space-containing install path, got status=${status} stderr=${stderr}`);
  } finally {
    rmSync(spaceBase, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
