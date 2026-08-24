// ceremony-drift-exit.test.mjs — the reporter's process-level contracts.
//
// Drives the real script as a subprocess with a stubbed `gh` on PATH, because
// the properties under test (exit code, which gh calls are made) cannot be
// observed by importing the module.
//
// HERMETIC BY CONSTRUCTION. Every case builds its own throwaway git repo with an
// explicit ticket fixture. An earlier version ran against THIS repository's live
// ticket store and hard-coded "drift exists" — so the moment the ceremony
// actually succeeded and drift reached zero, the reporter would correctly close
// the issue and this suite would fail, breaking `npm test` for every later PR
// precisely because the feature worked. A test must not punish the outcome it
// exists to enable.
//
// The exit contract has two halves, and conflating them was a real defect caught
// in review: drift EXISTING must never fail the job (that would recreate the
// blocking-gate problem the design avoids), while the REPORTER being broken must
// fail loudly (otherwise a revoked token silently disables the signal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ceremony-drift.mjs');
// The login `gh` ACTUALLY reports for the Actions bot, recorded from this repo:
//
//   $ gh issue view 264 --json author
//   {"author":{"is_bot":true,"login":"app/github-actions"}}
//
// This was 'github-actions[bot]' — the REST actor name, which `gh issue list
// --json author` never emits. Every stub here therefore fed the reporter an
// author it does not receive in production, and the end-to-end "never a
// duplicate" assertions below passed while the real job opened a duplicate on
// every push to main (#265). A stub is only evidence if it lies the way the
// outside world does; hard-code the recorded payload, not a plausible one.
const BOT = 'app/github-actions';

/**
 * Build a throwaway git repo whose drift state is exactly what the test wants.
 * @param {{drift: boolean}} opts drift:true → one shipped rail-freezing ticket
 */
function makeRepo({ drift }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-drift-repo-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '.');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'test');
  // Fixtures must not inherit the developer's git configuration. With
  // `commit.gpgsign=true` globally (common), these commits fail whenever the
  // signing agent is locked or absent — a spurious failure in a test that has
  // nothing to do with signing, and one that differs between a laptop and CI.
  run('config', 'commit.gpgsign', 'false');
  run('config', 'tag.gpgsign', 'false');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'core', 'a.mjs'), 'export const a = 1;\n');
  // Scope resolves to a tracked file => "shipped". Rails non-empty => rails-freeze.
  // `completed: true` expires it, which is the no-drift fixture.
  const ticket = {
    id: 'T1', title: 'fixture',
    scope: ['packages/core/**'], rails: ['packages/core/**'],
    ...(drift ? {} : { completed: true }),
  };
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
  run('add', '-A');
  run('commit', '-qm', 'fixture');
  return dir;
}

/** Run the reporter in `repo` with a fake `gh` first on PATH. Returns the gh call log too. */
function runWith(ghScript, { repo, env = {} } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), 'adlc-drift-bin-'));
  try {
    const log = join(binDir, 'calls.txt');
    const ghPath = join(binDir, 'gh');
    // Drain stdin first. The reporter pipes the issue body to `gh ... --body-file -`;
    // real gh reads it, but a stub that printf's and exits leaves the writer on a
    // closed pipe -> EPIPE -> spurious non-zero exit. Node 22 tolerated the race;
    // Node 18/20 surfaced it, so this passed locally and failed in CI.
    writeFileSync(ghPath, `#!/bin/sh\ncat >/dev/null 2>&1\necho "$*" >> ${log}\n${ghScript}\n`);
    chmodSync(ghPath, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADLC_RAILS_BYPASS: undefined, // keep the harness hermetic (see issue #204)
        BASE_REF: 'HEAD', // the fixture repo has no origin/main
        PATH: `${binDir}:${process.env.PATH}`,
        ...env,
      },
    });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch {}
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', calls };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

const withRepo = (opts, fn) => {
  const repo = makeRepo(opts);
  try { return fn(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
};

/** gh stub: `issue list` returns `listJson`, everything else succeeds. */
const stubListing = (listJson) =>
  `case "$*" in *"issue list"*) printf '%s' '${listJson}' ;; *) printf '%s' "https://example.test/issues/42" ;; esac\nexit 0`;

/** gh stub: nothing under the label, `listJson` on the unlabeled sweep. */
const stubUnlabeled = (listJson) => `
case "$*" in
  *"--label ceremony-drift"*"--json"*) printf '%s' "[]" ;;
  *"issue list"*)                      printf '%s' '${listJson}' ;;
  *)                                   printf '%s' "https://example.test/issues/42" ;;
esac
exit 0`;

const marked = (extra) =>
  `[{"number":42,"title":"stale","body":"<!-- adlc:ceremony-drift --> old","author":{"is_bot":true,"login":"${extra}"}}]`;

// ---- operational failure must be LOUD ----

test('a failing `gh` exits non-zero (a broken reporter must not look healthy)', () => {
  withRepo({ drift: true }, (repo) => {
    const r = runWith('echo "gh: HTTP 403 Resource not accessible" >&2; exit 1', { repo });
    assert.notEqual(r.status, 0);
  });
});

test('a `gh` returning unparseable JSON exits non-zero', () => {
  withRepo({ drift: true }, (repo) => {
    assert.notEqual(runWith('printf "%s" "not json"', { repo }).status, 0);
  });
});

test('a missing `gh` binary exits non-zero', () => {
  withRepo({ drift: true }, (repo) => {
    const empty = mkdtempSync(join(tmpdir(), 'adlc-drift-nogh-'));
    try {
      const r = spawnSync(process.execPath, [SCRIPT], {
        cwd: repo, encoding: 'utf8',
        env: { ...process.env, ADLC_RAILS_BYPASS: undefined, BASE_REF: 'HEAD', PATH: empty },
      });
      assert.notEqual(r.status, 0);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

// ---- drift existing must stay QUIET ----

test('drift present with a working `gh` exits 0 and opens a tracker', () => {
  withRepo({ drift: true }, (repo) => {
    const r = runWith(stubListing('[]'), { repo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 ticket\(s\) awaiting the completion ceremony/);
    assert.match(r.calls, /issue create/);
  });
});

test('DRY_RUN reports drift and exits 0 without touching `gh`', () => {
  withRepo({ drift: true }, (repo) => {
    const r = runWith('exit 1', { repo, env: { DRY_RUN: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY_RUN=1, no issue changes/);
  });
});

// ---- close-on-clear, end to end ----
//
// The case the previous version structurally could not express, because it read
// the live store: drift genuinely cleared, tracker open, must CLOSE.

test('no drift with an open tracker closes it (exit 0)', () => {
  withRepo({ drift: false }, (repo) => {
    const r = runWith(stubListing(marked(BOT)), { repo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0 ticket\(s\) awaiting/);
    assert.match(r.stdout, /closed issue #42/);
    assert.match(r.calls, /issue close 42/);
  });
});

test('no drift and no tracker does nothing (exit 0)', () => {
  withRepo({ drift: false }, (repo) => {
    const r = runWith(stubListing('[]'), { repo });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.calls, /issue create/);
  });
});

// ---- the tracker survives having its label stripped ----

test('an UNLABELED tracker authored by the bot is adopted, relabeled, and updated', () => {
  withRepo({ drift: true }, (repo) => {
    const r = runWith(stubUnlabeled(marked(BOT)), { repo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-attached 'ceremony-drift' to issue #42/);
    assert.match(r.calls, /issue edit 42 --add-label ceremony-drift/);
    assert.match(r.stdout, /updated issue #42/);
    assert.doesNotMatch(r.calls, /issue create/); // never a duplicate
  });
});

// A malformed active-ticket pointer must not crash the reporter, and must not
// let it advertise completing tickets when it cannot tell which one is live.
// This drives the real Result-shaped API, which unit tests (passing a plain id)
// cannot exercise — the first version read the Result as a bare id, silently
// disabling the exclusion.
test('a malformed active-ticket pointer still exits 0 and suppresses bulk advice', () => {
  withRepo({ drift: true }, (repo) => {
    writeFileSync(join(repo, '.adlc', 'current-ticket.json'), '{ not valid json');
    const r = runWith(stubListing('[]'), { repo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pointer unresolvable|treating as none|suppressing bulk-completion/);
  });
});

test('a well-formed pointer is reported as an exclusion, not as an object', () => {
  withRepo({ drift: true }, (repo) => {
    writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
    const r = runWith(stubListing('[]'), { repo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /active ticket is T1 \(excluded from bulk advice\)/);
    assert.doesNotMatch(r.stdout, /\[object Object\]/);
  });
});

// ---- the marker is public, so it is not authorization ----

test('a FORGED marker from another author is not adopted', () => {
  withRepo({ drift: true }, (repo) => {
    const r = runWith(stubUnlabeled(marked('untrusted-user')), { repo });
    assert.equal(r.status, 0, r.stderr);
    // Must not label, rewrite, or close someone else's issue...
    assert.doesNotMatch(r.calls, /issue edit 42/);
    assert.doesNotMatch(r.calls, /issue close 42/);
    // ...and must still do its own job.
    assert.match(r.calls, /issue create/);
  });
});

test('two marked issues fail closed rather than guessing which to overwrite', () => {
  withRepo({ drift: true }, (repo) => {
    const two =
      `[{"number":42,"title":"a","body":"<!-- adlc:ceremony-drift --> a","author":{"is_bot":true,"login":"${BOT}"}},` +
      `{"number":43,"title":"b","body":"<!-- adlc:ceremony-drift --> b","author":{"is_bot":true,"login":"${BOT}"}}]`;
    const r = runWith(stubUnlabeled(two), { repo });
    assert.notEqual(r.status, 0, 'ambiguous match must not silently pick one');
    assert.match(r.stderr, /ambiguous tracking issue/);
    assert.doesNotMatch(r.calls, /issue close/);
  });
});

// ---- the documented command must not write outside the reported set ----
//
// The report is built from `needsCeremony`, which contains only rail-freezing and
// preexisting-completed-field entries. `ticket-prune --ceremony --write` ALSO
// tombstones rails-less stale tickets — which never appear in the report. An
// operator running the advertised command on the strength of what the issue lists
// would then complete a rails-less ticket that may still be in progress.
//
// This drives the EXACT command string the reporter renders, so the test fails if
// someone reintroduces `--write` into it.

function makeMixedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-drift-mixed-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '.');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false'); // see makeRepo: do not inherit signing
  g('config', 'tag.gpgsign', 'false');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'util'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'core', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'packages', 'util', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [
    // Rail-freezing and stale → appears in the report.
    { id: 'RAILED', title: 'railed', scope: ['packages/core/**'], rails: ['packages/core/**'] },
    // Rails-less; scope already resolves so it LOOKS stale, but it is in progress.
    // It never appears in needsCeremony, so the report never mentions it.
    { id: 'RAILLESS', title: 'rails-less in progress', scope: ['packages/util/**'] },
  ] }));
  g('add', '-A');
  g('commit', '-m', 'fixture');
  return dir;
}

const completedIds = (repo) =>
  JSON.parse(readFileSync(join(repo, '.adlc', 'tickets.json'), 'utf8'))
    .tickets.filter((t) => t.completed === true).map((t) => t.id).sort();

test('the rendered per-ticket command completes only its named ticket, nothing else', async () => {
  const repo = makeMixedRepo();
  try {
    // Take the command straight out of the rendered issue body and run it through
    // the UMBRELLA `adlc` dispatcher — exactly the binary an operator has on PATH.
    // An earlier version invoked packages/tickets' source bin directly, which hid
    // that the reporter was printing `adlc-tickets` (not exposed by @adlc/cli); the
    // command an operator copies must resolve through `adlc`. RAILED carries a
    // done-status, so it gets a ready `adlc ticket complete RAILED` line. The
    // point: running EXACTLY what the issue prints completes only RAILED and never
    // touches RAILLESS, which never appeared in the report.
    const { renderIssueBody } = await import('../ceremony-drift.mjs');
    const body = renderIssueBody([
      { id: 'RAILED', reason: 'explicit status: "done"', rails: ['packages/core/**'], blocker: 'rails-freeze' },
    ]);
    const cmd = body.split('\n').map((l) => l.trim())
      .find((l) => /^adlc ticket complete \S+ --write --authorize --json$/.test(l));
    assert.ok(cmd, 'an explicit-done entry should document `adlc ticket complete … --json`');

    // Dispatch through the real `adlc` entrypoint, passing the printed args verbatim.
    const args = cmd.replace(/^adlc\s+/, '').trim().split(/\s+/);
    const ADLC = join(REPO_ROOT, 'packages', 'cli', 'bin', 'adlc.mjs');
    // RAILED declares a rail, so this store is a frozen trust root: the rendered
    // command is an AUDITED override and refuses without a signing key — which is
    // why the body now tells the admin to export one before running these
    // (packages/tickets/test/bypass-audit.test.mjs). Supplying it here is what an
    // admin running the ceremony does; the command text itself is unchanged.
    execFileSync(process.execPath, [ADLC, ...args], {
      cwd: repo, stdio: 'ignore', env: { ...process.env, ADLC_MANIFEST_KEY: 'test-manifest-key' },
    });

    assert.deepEqual(completedIds(repo), ['RAILED'],
      'the rails-less ticket must be untouched — it never appeared in the report');
    // The canonical path records completion evidence; the raw-edit remedy did not.
    assert.ok(existsSync(join(repo, '.adlc', 'manifest.jsonl')),
      'completion must be journaled to the manifest');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- a truncated recovery scan must not be treated as "not found" ----
//
// If the unlabeled sweep fills its window without a match, whether a tracker
// exists is UNKNOWN. Acting on it would open a duplicate (drift present) or
// leave an obsolete warning open (drift cleared) — the exact pair of failures
// this recovery path exists to prevent. A previous revision logged a warning and
// proceeded anyway; a loud bad inference is still a bad inference. These assert
// the run fails and mutates nothing.

/** gh stub whose unlabeled sweep returns a full window of unmarked issues. */
function stubSaturatedSweep(dir) {
  const many = JSON.stringify(
    Array.from({ length: 1000 }, (_, i) => ({
      number: i + 1, title: `unrelated ${i}`, body: 'nothing here', author: { login: 'someone' },
    }))
  );
  const payload = join(dir, 'many.json');
  writeFileSync(payload, many);
  return `
case "$*" in
  *"--label ceremony-drift"*"--json"*) printf '%s' "[]" ;;
  *"issue list"*)                      cat ${payload} ;;
  *)                                   printf '%s' "https://example.test/issues/99" ;;
esac
exit 0`;
}

for (const drift of [true, false]) {
  test(`a saturated sweep with drift=${drift} exits non-zero and mutates nothing`, () => {
    const repo = makeRepo({ drift });
    const payloadDir = mkdtempSync(join(tmpdir(), 'adlc-drift-payload-'));
    try {
      const r = runWith(stubSaturatedSweep(payloadDir), { repo });
      assert.notEqual(r.status, 0, 'an indeterminate scan must fail the run');
      assert.match(r.stderr, /scan hit that limit|Refusing to open or close/);
      assert.doesNotMatch(r.calls, /issue create/, 'must not open a duplicate');
      assert.doesNotMatch(r.calls, /issue close/, 'must not close on an unknown');
      assert.doesNotMatch(r.calls, /issue edit \d+ --title/, 'must not rewrite a tracker');
    } finally {
      rmSync(payloadDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

// The bound only fails closed when it is actually reached — an exhaustive scan
// that finds nothing is a legitimate "no tracker", and must still open one.
test('an UNSATURATED sweep finding nothing is treated as an exhaustive miss', () => {
  withRepo({ drift: true }, (repo) => {
    const r = runWith(stubUnlabeled('[]'), { repo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /issue create/);
  });
});
