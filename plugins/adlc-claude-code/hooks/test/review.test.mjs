// review.test.mjs — the Stop-hook mechanical adversarial-review trigger
// (issue #59). Drives the real hook entrypoint as a subprocess against a real
// temp git repo (same style as rails.test.mjs), so the git-diffing wiring is
// exercised end to end, not just the pure risk-tier matcher (covered directly,
// with a mocked manifest state, in packages/core/test/risk-tier.test.mjs).
//
// Contract: `review` is ADVISORY by default (systemMessage only, never
// blocks), and only emits a Stop `decision: "block"` when the operator opts in
// via ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1. It is silent whenever: the repo
// isn't ADLC-initialized; nothing changed; changes don't touch a risk-tier
// path; or a satisfying `adversarial-review` gate-manifest record already
// exists for the active ticket (or, with no active ticket, any record at all).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');
const NODE_DIR = dirname(process.execPath);
const REPO_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '.bin');
const WITH_ADLC = `${REPO_BIN}:${NODE_DIR}:${process.env.PATH ?? ''}`; // adlc reachable

function git(args, cwd) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/**
 * Build a throwaway git repo initialized as an ADLC repo (.adlc/tickets.json
 * present), with one committed baseline file so `main` exists as a real ref.
 */
function initRepo({ tickets = '{"tickets":[]}', currentTicket = null, manifestLines = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-review-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), tickets);
  if (currentTicket !== null) {
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: currentTicket }));
  }
  if (manifestLines !== null) {
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), manifestLines);
  }
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'baseline'], dir);
  return dir;
}

/** Run the `review` Stop hook against `dir`. Returns { out, verdict, blocked }. */
function runReview(dir, { env = {} } = {}) {
  const input = JSON.stringify({ cwd: dir });
  let out = '';
  try {
    out = execFileSync(process.execPath, [HOOK, 'review'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH, ...env },
      cwd: dir,
    });
  } catch (e) {
    out = e.stdout ?? '';
  }
  return {
    out,
    hasNotice: out.includes('adversarial-review'),
    blocked: out.includes('"decision":"block"'),
  };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---- no-op guards ----

test('no .adlc dir → silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-review-noadlc-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  try {
    const r = runReview(dir);
    assert.equal(r.out.trim(), '');
  } finally {
    cleanup(dir);
  }
});

test('ADLC repo, clean working tree, no branch divergence → silent', () => {
  const dir = initRepo();
  try {
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.out.trim(), '');
  } finally {
    cleanup(dir);
  }
});

test('changed file does NOT touch a risk-tier path → silent', () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'src-notes.md'), 'just some notes\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.out.trim(), '');
  } finally {
    cleanup(dir);
  }
});

// ---- risk-gated, unreviewed → advisory notice ----

test('risk-gated untracked file, no manifest at all → advisory notice (not blocking)', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true);
    assert.equal(r.blocked, false);
  } finally {
    cleanup(dir);
  }
});

// Regression for the fbf4a38 fix: the remediation text once told operators to
// run `gate-manifest record adversarial-review --evidence '...'`, but
// `gate-manifest record` only accepts --ticket/--data/--files and throws
// ERR_PARSE_ARGS_UNKNOWN_OPTION on --evidence. Assert the printed command uses
// only real flags so this specific regression can't silently creep back in.
test('advisory notice remediation text uses --files/--data, never the non-existent --evidence flag', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.match(r.out, /gate-manifest record adversarial-review/);
    assert.match(r.out, /--files/);
    assert.match(r.out, /--data/);
    assert.doesNotMatch(r.out, /--evidence/);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated CI/CD file (.github/workflows) → advisory notice', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'deploy.yml'), 'name: deploy\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated change + ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1 → blocking notice', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC, ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT: '1' } });
    assert.equal(r.hasNotice, true);
    assert.equal(r.blocked, true);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated change but adlc unreachable (no manifest file at all) → still advisory (cannot prove satisfied)', () => {
  const dir = initRepo();
  const noAdlcDir = mkdtempSync(join(tmpdir(), 'adlc-no-cli-'));
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    // git must stay reachable (only `adlc` is meant to be missing here) — point
    // PATH at the empty dir FIRST, then real git's directory, so `adlc` resolves
    // to nothing while `git` still works.
    const r = runReview(dir, { env: { PATH: `${noAdlcDir}:${dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())}` } });
    assert.equal(r.hasNotice, true);
    assert.equal(r.blocked, false);
  } finally {
    cleanup(dir);
    cleanup(noAdlcDir);
  }
});

// ---- already satisfied → silent ----

test('risk-gated change + adversarial-review recorded (no ticket scoping) → silent', () => {
  const dir = initRepo({ manifestLines: `${JSON.stringify({ seq: 1, gate: 'adversarial-review', ts: '2026-07-01T00:00:00.000Z' })}\n` });
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, false);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated change + adversarial-review recorded for the ACTIVE ticket → silent', () => {
  const dir = initRepo({
    currentTicket: 'T1',
    manifestLines: `${JSON.stringify({ seq: 1, gate: 'adversarial-review', ticket: 'T1', ts: '2026-07-01T00:00:00.000Z' })}\n`,
  });
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, false);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated change + adversarial-review recorded for a DIFFERENT ticket → still advisory notice', () => {
  const dir = initRepo({
    currentTicket: 'T1',
    manifestLines: `${JSON.stringify({ seq: 1, gate: 'adversarial-review', ticket: 'T2', ts: '2026-07-01T00:00:00.000Z' })}\n`,
  });
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated change + only an UNRELATED gate recorded → still advisory notice', () => {
  const dir = initRepo({ manifestLines: `${JSON.stringify({ seq: 1, gate: 'rails-bypass', ts: '2026-07-01T00:00:00.000Z' })}\n` });
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated change + adversarial-review recorded with --files for a DIFFERENT (non-overlapping) path → still advisory notice', () => {
  const dir = initRepo({
    manifestLines: `${JSON.stringify({ seq: 1, gate: 'adversarial-review', ts: '2026-07-01T00:00:00.000Z', files: { 'unrelated/file.mjs': 'deadbeef' } })}\n`,
  });
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true);
  } finally {
    cleanup(dir);
  }
});

test('risk-gated change + adversarial-review recorded with --files overlapping the gated path → silent', () => {
  const dir = initRepo({
    manifestLines: `${JSON.stringify({ seq: 1, gate: 'adversarial-review', ts: '2026-07-01T00:00:00.000Z', files: { 'src/auth/login.mjs': 'deadbeef' } })}\n`,
  });
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, false);
  } finally {
    cleanup(dir);
  }
});

// ---- quoted git-status paths (space/unusual chars) are correctly unquoted ----

test('modified TRACKED file with a space in its path + no resolvable trunk base → git status quoting is unquoted, notice still fires', () => {
  // git status --porcelain (unlike git diff --name-only) C-quotes any path
  // containing a space, e.g. ` M "secrets/api key.pem"`. Init WITHOUT a
  // main/master branch so the diff-vs-trunk fallback (which never quotes) is
  // unavailable and detection depends entirely on the status parse.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-review-quoted-'));
  git(['init', '-b', 'trunk'], dir); // deliberately not main/master/origin/*
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}');
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'api key.pem'), 'orig\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'baseline'], dir);
  try {
    writeFileSync(join(dir, 'secrets', 'api key.pem'), 'modified\n');
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true);
    assert.equal(r.blocked, false);
  } finally {
    cleanup(dir);
  }
});

// ---- committed (not just untracked) risk-gated changes on the branch ----

test('risk-gated change already COMMITTED on the branch (vs main) still triggers a notice', () => {
  const dir = initRepo();
  try {
    git(['checkout', '-b', 'feature/x'], dir);
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'add auth'], dir);
    assert.ok(existsSync(join(dir, 'src', 'auth', 'login.mjs')));
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true);
  } finally {
    cleanup(dir);
  }
});

// Regression for 00cd52e: `main` can EXIST as a ref (orphan branch, stale ref
// after a history rewrite, shallow clone) yet share no common history with
// HEAD, so `git merge-base main HEAD` fails even though
// `git rev-parse --verify main^{commit}` succeeds. The old `.find(existsAsRef)`
// logic stopped at the first EXISTING candidate and never tried `master`,
// silently dropping the committed-diff contribution to `changed` even though
// `master` is a real, resolvable ancestor of the feature branch. This test
// only passes if the retry-on-merge-base-failure loop keeps trying candidates
// past an existing-but-unrelated `main`.
test('main exists but shares no history with HEAD (orphan ref) → retries master, which is the real ancestor, and still triggers a notice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-review-orphan-main-'));
  try {
    // Real trunk is `master`, not `main`.
    git(['init', '-b', 'master'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}');
    writeFileSync(join(dir, 'README.md'), 'baseline\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'baseline'], dir);

    // Feature branch off master, with a risk-gated file committed on it.
    git(['checkout', '-b', 'feature/x'], dir);
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'add auth'], dir);

    // Now create `main` as an ORPHAN ref — exists, but shares zero history
    // with feature/x (or master). Simulates a stale ref after a history
    // rewrite / an unrelated shallow-clone ref.
    git(['checkout', '--orphan', 'main'], dir);
    writeFileSync(join(dir, 'unrelated.txt'), 'orphan history\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'unrelated orphan commit'], dir);

    git(['checkout', 'feature/x'], dir);
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, true, `expected notice despite main being an unrelated orphan ref, got: ${r.out}`);
  } finally {
    cleanup(dir);
  }
});

// ---- diff base is the merge-base (fork point), not main's live tip ----

test('main moves a risk-tier file AFTER branch divergence → branch that never touched it stays silent', () => {
  const dir = initRepo();
  try {
    git(['checkout', '-b', 'feature/harmless'], dir);
    writeFileSync(join(dir, 'notes.md'), 'just notes\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'add notes'], dir);

    // Trunk advances AFTER the fork point, touching a risk-tier path the
    // feature branch never touched.
    git(['checkout', 'main'], dir);
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'add auth on main'], dir);

    git(['checkout', 'feature/harmless'], dir);
    const r = runReview(dir, { env: { PATH: WITH_ADLC } });
    assert.equal(r.hasNotice, false, `expected silence (only main advanced), got: ${r.out}`);
  } finally {
    cleanup(dir);
  }
});

// ---- loop guard: enforcement never re-blocks once Stop already forced a continuation ----

test('ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1 + stop_hook_active=true → advisory only, does not block again', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), 'export function login() {}\n');
    const input = JSON.stringify({ cwd: dir, stop_hook_active: true });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'review'], {
        input,
        encoding: 'utf8',
        env: { ...process.env, PATH: WITH_ADLC, ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT: '1' },
        cwd: dir,
      });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.ok(out.includes('adversarial-review'), `expected a notice, got: ${out}`);
    assert.equal(out.includes('"decision":"block"'), false, `must not re-block: ${out}`);
  } finally {
    cleanup(dir);
  }
});
