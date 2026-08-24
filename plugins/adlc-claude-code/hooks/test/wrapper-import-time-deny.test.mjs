// adlc-hook-run wrapper — an import-time failure in entry-point (bin) detection must
// DENY for enforcing modes, never crash fail-open.
//
// Seam 6 (PR #497) established that in Claude Code only exit 2 blocks a tool call; an
// uncaught crash exits 1, which is the fail-OPEN path that seam existed to close. The
// wrapper's entry-point probe called realpathSync(process.argv[1]) unguarded during
// module evaluation, so a virtual or non-existent argv[1] (bundlers, embedded REPLs,
// test runners with synthetic entry points) threw ENOENT before dispatch() ever ran —
// bypassing the seam-6 fix entirely. Reproduced on main: exit 1 + an ENOENT stack trace.
//
// The other fail-open direction matters just as much: when argv[1] cannot be resolved we
// cannot prove we are NOT the entry point, and silently doing nothing exits 0, which lets
// the tool proceed ungated. So 'unknown' denies for enforcing modes.
//
// THIS FILE DELIBERATELY DOES NOT IMPORT THE WRAPPER. Evaluating that module can exit the
// process by design, so any defect that makes it misjudge the entry point would terminate
// an importing test file mid-load — silently, with status 0, taking every assertion in the
// file with it. Driving it only through spawned children keeps this suite alive to fail.
// The unit tests that do import it live in wrapper-entry-point.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_RUN_URL = pathToFileURL(join(HOOKS_DIR, 'adlc-hook-run.mjs')).href;

// Stated literally rather than imported, to keep this file free of the wrapper module.
// wrapper-timeout-deny.test.mjs already pins ENFORCING_MODES to exactly this set.
const ENFORCING_MODES = ['rails', 'buildgate', 'handoff'];
const ADVISORY_MODES = ['preflight', 'context', 'flail', 'manifest', 'review', 'handoffstart'];

/** A path that cannot be resolved on disk — not even its parent directory exists. */
const VIRTUAL_ENTRY = '/nonexistent/virtual-entry.mjs';

/** Printed by the child only if module evaluation returned control to it. */
const SENTINEL = 'IMPORT-COMPLETED';

/**
 * Import the wrapper inside a real child process whose argv[1] is `argv1`, mirroring a
 * host that hands node a virtual entry point. Spawn-based on purpose: the defect is an
 * uncaught throw during module evaluation, and only a real process exit code can show
 * whether it denied (2) or crashed fail-open (1).
 */
function importWithEntry(argv1, mode) {
  const src = [
    `process.argv[1] = ${JSON.stringify(argv1)};`,
    `process.argv[2] = ${JSON.stringify(mode)};`,
    `await import(${JSON.stringify(HOOK_RUN_URL)});`,
    `console.log(${JSON.stringify(SENTINEL)});`,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });
}

describe('adlc-hook-run: unresolvable argv[1] at import time (spawned, real exit codes)', () => {
  for (const mode of ENFORCING_MODES) {
    it(`enforcing mode '${mode}' denies with exit 2, not an uncaught crash`, () => {
      const r = importWithEntry(VIRTUAL_ENTRY, mode);
      assert.equal(r.status, 2, `expected deny (2), got ${r.status}. stderr: ${r.stderr}`);
      assert.match(r.stderr, /DENY/);
      assert.match(r.stderr, new RegExp(mode));
    });

    it(`enforcing mode '${mode}' says which input was unresolvable and that it blocked`, () => {
      const r = importWithEntry(VIRTUAL_ENTRY, mode);
      // Claude Code feeds a denying hook's stderr back to the model, so the message is
      // behavior: it has to name the offending input and state that the call was blocked.
      assert.match(r.stderr, /argv\[1\]: \/nonexistent\/virtual-entry\.mjs/);
      assert.match(r.stderr, /Denying rather than allowing an ungated tool call\./);
    });

    it(`enforcing mode '${mode}' emits a deny message, not a stack trace`, () => {
      const r = importWithEntry(VIRTUAL_ENTRY, mode);
      // The original defect surfaced as an ENOENT trace from node:fs. If any of these
      // appear the wrapper crashed rather than denied, even if the code happened to be 2.
      assert.doesNotMatch(r.stderr, /ENOENT/);
      assert.doesNotMatch(r.stderr, /ModuleJob/);
      assert.doesNotMatch(r.stderr, /^\s+at /m);
    });
  }

  for (const mode of ADVISORY_MODES) {
    it(`advisory mode '${mode}' stays non-blocking (exit 0) and still does not crash`, () => {
      const r = importWithEntry(VIRTUAL_ENTRY, mode);
      assert.equal(r.status, 0, `advisory must not block, got ${r.status}. stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /ENOENT/);
      assert.doesNotMatch(r.stderr, /^\s+at /m);
    });

    it(`advisory mode '${mode}' is diagnosed but never worded as a block`, () => {
      const r = importWithEntry(VIRTUAL_ENTRY, mode);
      assert.match(r.stderr, /cannot resolve the wrapper's own entry point/);
      assert.doesNotMatch(r.stderr, /DENY/);
      assert.doesNotMatch(r.stderr, /Denying rather than allowing/);
    });
  }

  it('an unknown mode stays non-blocking (an unrecognised mode is not an enforcing one)', () => {
    const r = importWithEntry(VIRTUAL_ENTRY, 'bogus-mode');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /DENY/);
  });

  it('a resolvable argv[1] that is not the wrapper imports cleanly and dispatches nothing', () => {
    // A directory resolves fine, so detection can prove we are NOT the entry point. The
    // sentinel is the load-bearing part: it proves module evaluation handed control back
    // instead of dispatching a hook and exiting. Without it, a wrapper that wrongly
    // self-executed here would still look like a pass whenever the hook happened to
    // exit 0 — and it must not turn a plain import into a deny either.
    for (const mode of ['rails', 'review']) {
      const r = importWithEntry(tmpdir(), mode);
      assert.equal(r.status, 0, `mode ${mode}: stderr: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(SENTINEL), `mode ${mode}: module evaluation exited`);
      assert.doesNotMatch(r.stderr, /DENY/, mode);
    }
  });

  it('an absent argv[1] imports cleanly and dispatches nothing', () => {
    const src = [
      `delete process.argv[1];`,
      `process.argv[2] = 'rails';`,
      `await import(${JSON.stringify(HOOK_RUN_URL)});`,
      `console.log(${JSON.stringify(SENTINEL)});`,
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      input: '',
      timeout: 60_000,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(SENTINEL));
  });
});
