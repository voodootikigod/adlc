// isMain-space-path.test.mjs — adlc-lifecycle.mjs's direct-execution guard
// built a `file://` URL manually (`file://${process.argv[1]}`) instead of
// using `pathToFileURL(...).href`. Node percent-encodes import.meta.url (a
// space becomes %20) but a manual template string does not, so ANY install
// path containing a space made the comparison always false — main() silently
// never ran and all seven lifecycle hooks it backs produced no output at all
// (exit 0, empty stdout), indistinguishable from "nothing to report".
//
// This is a genuine subprocess test: it copies the real hooks directory to a
// space-containing path and executes THAT copy, because the bug depends on
// process.argv[1]'s actual on-disk path, not on any fixture cwd. It asserts
// on whether main() ran AT ALL, independent of any mode's business-logic data
// shape (context/verify/review modes all legitimately return null output when
// there's nothing to report) — an UNKNOWN mode deterministically throws
// inside main(), which the top-level catch always prints as a systemMessage.
// If main() never ran (the bug), nothing is printed and stdout is empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

test('adlc-lifecycle.mjs still runs main() when its OWN install path contains a space', () => {
  // realpathSync the mkdtemp base BEFORE appending the space-containing
  // segment: on macOS, os.tmpdir() is under /tmp, itself a symlink to
  // /private/tmp. import.meta.url reports the REALPATH-resolved location, so
  // comparing it against a path built from the UNRESOLVED /tmp/... alias
  // would report "not equal" for a reason unrelated to this test's subject.
  const spaceBase = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-lifecycle-space-base-')));
  const spaceRoot = join(spaceBase, 'adlc lifecycle space');
  mkdirSync(spaceRoot, { recursive: true });
  try {
    const hooksCopy = join(spaceRoot, 'hooks');
    cpSync(HOOKS_DIR, hooksCopy, { recursive: true });
    const hookCopyPath = join(hooksCopy, 'adlc-lifecycle.mjs');

    const env = {
      ...process.env,
      NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
    };

    let status = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(process.execPath, [hookCopyPath, 'bogus-mode-xyz'], {
        input: '{}',
        encoding: 'utf8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status ?? 1;
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }

    // The advisory catch handler always exits 0, even on an unrecognized
    // mode — it must print a systemMessage naming the exact failure. Before
    // the fix, main() silently never ran from a space-containing install
    // path and stdout was completely empty.
    assert.equal(status, 0, `expected the advisory hook to exit 0, got status=${status} stderr=${stderr}`);
    assert.notEqual(stdout.trim(), '', 'expected main() to have run and printed a systemMessage — stdout was empty');
    const parsed = JSON.parse(stdout.trim());
    assert.match(
      parsed.systemMessage ?? '',
      /unknown lifecycle mode: bogus-mode-xyz/,
      `expected the caught unknown-mode error, got: ${JSON.stringify(parsed)}`
    );
  } finally {
    rmSync(spaceBase, { recursive: true, force: true });
  }
});

test('adlc-lifecycle.mjs still runs main() with NO mode argument (default context mode) from a space-containing install path', () => {
  // Distinguishes isMain's process.argv[1] (the script path) from
  // process.argv[2] (the mode argument, absent here — defaults to
  // 'context'). A mutant that checks Boolean(process.argv[2]) instead of
  // Boolean(process.argv[1]) is invisible to the sibling test above (which
  // always supplies a mode argument, making argv[2] truthy too); only a
  // no-mode-argument invocation exercises the argv[1] vs argv[2] boundary.
  const spaceBase = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-lifecycle-space-nomode-')));
  const spaceRoot = join(spaceBase, 'adlc lifecycle nomode space');
  mkdirSync(spaceRoot, { recursive: true });
  const repoRoot = mkdtempSync(join(tmpdir(), 'adlc-lifecycle-nomode-repo-'));
  try {
    const hooksCopy = join(spaceRoot, 'hooks');
    cpSync(HOOKS_DIR, hooksCopy, { recursive: true });
    const hookCopyPath = join(hooksCopy, 'adlc-lifecycle.mjs');

    mkdirSync(join(repoRoot, '.adlc'), { recursive: true });
    const ticket = { id: 'T1', title: 'space nomode', category: 'contract', scope: ['src/**'], rails: [], edges: [] };
    writeFileSync(join(repoRoot, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [ticket] }, null, 2)}\n`);
    writeFileSync(join(repoRoot, '.adlc/current-ticket.json'), `${JSON.stringify({ id: ticket.id })}\n`);

    const env = {
      ...process.env,
      NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
    };

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [hookCopyPath], {
        input: JSON.stringify({ cwd: repoRoot }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      stdout = e.stdout ?? '';
    }

    assert.notEqual(stdout.trim(), '', 'expected default context-mode output naming the active ticket — stdout was empty');
    const parsed = JSON.parse(stdout.trim());
    assert.match(
      parsed.additionalContext ?? '',
      /ADLC current ticket: T1/,
      `expected the active-ticket context narration, got: ${JSON.stringify(parsed)}`
    );
  } finally {
    rmSync(spaceBase, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('isMain uses pathToFileURL, matching adlc-build-gate.mjs\'s already-correct pattern', () => {
  const lifecycle = readFileSync(join(HOOKS_DIR, 'adlc-lifecycle.mjs'), 'utf8');
  const buildGate = readFileSync(join(HOOKS_DIR, 'adlc-build-gate.mjs'), 'utf8');
  assert.match(lifecycle, /pathToFileURL\(process\.argv\[1\]\)\.href/, 'adlc-lifecycle.mjs must use pathToFileURL, not a hand-built file:// string');
  assert.match(buildGate, /pathToFileURL\(process\.argv\[1\]\)\.href/, 'adlc-build-gate.mjs (the reference pattern) must still be correct — regression guard');
});
