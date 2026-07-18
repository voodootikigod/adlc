// ceremony-drift-exit.test.mjs — the exit-code contract of the drift reporter.
//
// Drives the real script as a subprocess with a stubbed `gh` on PATH, because
// the property under test is the process exit code, which cannot be observed by
// importing the module.
//
// The contract has two halves, and conflating them was a real defect caught in
// review: drift EXISTING must never fail the job (that would recreate the
// blocking-gate problem the design exists to avoid), while the REPORTER being
// broken must fail loudly (otherwise a revoked token or API error disables the
// signal indefinitely while every scheduled run still looks green).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'ceremony-drift.mjs');

/**
 * Run the reporter with a fake `gh` first on PATH.
 * @param {string} ghScript shell body for the stub
 */
function runWith(ghScript, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-drift-'));
  try {
    const ghPath = join(dir, 'gh');
    writeFileSync(ghPath, `#!/bin/sh\n${ghScript}\n`);
    chmodSync(ghPath, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADLC_RAILS_BYPASS: undefined, // keep the harness hermetic (see issue #204)
        PATH: `${dir}:${process.env.PATH}`,
        ...env,
      },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- operational failure must be LOUD ----

test('a failing `gh` exits non-zero (a broken reporter must not look healthy)', () => {
  const r = runWith('echo "gh: HTTP 403 Resource not accessible by integration" >&2; exit 1');
  assert.notEqual(r.status, 0, 'expected a non-zero exit when gh fails');
});

test('a `gh` that returns unparseable JSON exits non-zero', () => {
  const r = runWith('echo "not json at all"');
  assert.notEqual(r.status, 0, 'expected a non-zero exit when the gh response cannot be parsed');
});

test('a missing `gh` binary exits non-zero', () => {
  // PATH is set to a dir with no gh at all.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-drift-nogh-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ADLC_RAILS_BYPASS: undefined, PATH: dir },
    });
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- drift existing must stay QUIET ----

test('drift present with a working `gh` exits 0 (drift is not a malfunction)', () => {
  // `issue list` yields no tracker → the script opens one; every gh call succeeds.
  const r = runWith('case "$*" in *"issue list"*) echo "[]";; *) echo "https://example.test/issues/1";; esac; exit 0');
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /ticket\(s\) awaiting the completion ceremony/);
});

test('DRY_RUN reports drift and exits 0 without touching `gh`', () => {
  // gh would fail if called; DRY_RUN must return before any issue I/O.
  const r = runWith('exit 1', { DRY_RUN: '1' });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /DRY_RUN=1, no issue changes/);
});

// ---- the tracker survives having its label stripped ----
//
// Label-scoped discovery is the fast path, but a label can be removed by hand.
// If lookup were label-only, that would silently open a DUPLICATE (active drift)
// or leave a stale issue open forever (cleared drift). The marker in the body is
// the durable identity; these prove the fallback is real rather than a comment.
//
// The stub distinguishes the labeled query from the unlabeled sweep so it can
// return "nothing labeled, but a marked issue exists".

// Single-line body on purpose: `echo` interprets backslash escapes in some
// /bin/sh implementations (dash does, bash does not), which would inject a real
// newline into the JSON string literal and make it unparseable. printf keeps
// this stable across shells.
const MARKED_ISSUE = '[{"number":42,"title":"stale title","body":"<!-- adlc:ceremony-drift --> old"}]';

const UNLABELED_STUB = `
case "$*" in
  *"--label ceremony-drift"*"--json"*) printf '%s' "[]" ;;                # labeled lookup: nothing
  *"issue list"*)                      printf '%s' '${MARKED_ISSUE}' ;;   # sweep: found by marker
  *)                                   printf '%s' "https://example.test/issues/42" ;;
esac
exit 0`;

test('an UNLABELED marked issue is found and updated, not duplicated', () => {
  const r = runWith(UNLABELED_STUB);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /re-attached 'ceremony-drift' to issue #42/);
  // Drift exists here (the real repo has 9), so it must UPDATE #42, never open.
  assert.match(r.stdout, /updated issue #42/);
  assert.doesNotMatch(r.stdout, /opened https/);
});

test('label re-attachment is attempted so the fast path works next run', () => {
  // Records every gh invocation so we can assert the self-heal actually ran.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-drift-log-'));
  try {
    const log = join(dir, 'calls.txt');
    const ghPath = join(dir, 'gh');
    writeFileSync(ghPath, `#!/bin/sh\necho "$*" >> ${log}\n${UNLABELED_STUB}\n`);
    chmodSync(ghPath, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ADLC_RAILS_BYPASS: undefined, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /issue edit 42 --add-label ceremony-drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
