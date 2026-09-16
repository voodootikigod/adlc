// apply-e2e.test.mjs — the write path through the real binary.
//
// The library seams are tested directly elsewhere. What only a spawned process
// exercises is the wiring: that `--apply` refuses without its set, that the
// reviewer and the writer are invoked as separate executables, and above all
// that a run which cannot review WRITES NOTHING. A fake `gh` on PATH records
// every call, so "nothing was written" is an assertion rather than a hope.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentHash } from '../lib/content-hash.mjs';

/**
 * Every sandbox this file creates, removed when the file finishes.
 *
 * `mkdtempSync` with no cleanup leaks a git repository per test, per run. That
 * is invisible until the filesystem runs out of INODES — which reports as "no
 * space left on device" while df still shows most of the disk free.
 */
const SANDBOXES = [];
const registerSandbox = (dir) => { SANDBOXES.push(dir); return dir; };
after(() => {
  for (const dir of SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'backlog-groom.mjs');

/**
 * A scratch repo with a recorded `gh` and a scripted `adversarial-review`.
 *
 * `reviewExit` is the reviewer's exit code — the whole verdict contract — and
 * the `gh` shim appends every invocation to a log, so a test can assert on
 * writes that did NOT happen.
 */
function sandbox({ reviewExit = 0, profile = null, ghFails = false } = {}) {
  const dir = registerSandbox(mkdtempSync(join(tmpdir(), 'groom-apply-')));
  const bin = join(dir, 'fakebin');
  mkdirSync(bin);
  const log = join(dir, 'gh.log');
  // The binary's TMPDIR, private to this sandbox. The artifact-directory tests
  // count `backlog-groom-*` entries, and in the shared system tmpdir any other
  // run of the binary — a concurrent test process, a second CI job on the same
  // runner — creates and removes the same prefix mid-count. A SIBLING of the
  // repo rather than inside it, so the artifacts never dirty the work tree the
  // tool reads from.
  const tmp = registerSandbox(mkdtempSync(join(tmpdir(), 'groom-apply-tmp-')));

  // The issue the set will act on, cited against a file that really exists in
  // this repo — the write path re-derives the contentHash from it, so a stub
  // that answers with an empty object is refused (correctly) before any write.
  const ISSUE = {
    number: 705,
    title: 'a real citation',
    // The cited snippet is ABSENT from the file at HEAD, which is what makes
    // this a genuinely `fixed` issue — the write path re-verifies the verdict,
    // so a fixture whose defect is still present is refused (correctly).
    body: '**Location** `src/cited.mjs:1`\n\n```\nconst removedLongAgo = 1;\n```\n',
    labels: [{ name: 'bug' }],
    updatedAt: '2026-09-01T00:00:00Z',
  };
  // A heredoc, not `echo`: dash's echo interprets backslash escapes, so the \n
  // inside the issue body would become a real newline and the JSON would arrive
  // corrupt — which the write path then reports as an unreadable issue.
  //
  // STDIN IS DRAINED FIRST. `issue comment` pipes its body in (`--body-file -`),
  // and a child that exits without reading closes the pipe's read end: if that
  // happens before node has written the body, spawnSync reports EPIPE, the writer
  // throws, and the run records a failed comment and never closes — after this
  // shim has already LOGGED the comment. That is #1018's exact signature, and it
  // is a race, not a size limit: with this fixture's ~200-byte body it hit 5 of
  // 2000 spawns on an idle machine and 675 of 2000 with the CPUs saturated, as a
  // CI runner executing test files in parallel is. Draining took both to 0.
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'cat > /dev/null',
      `echo "$@" >> ${log}`,
      'case "$*" in',
      '  *"--json comments"*)',
      "    cat <<'JSON'",
      '{"comments":[]}',
      'JSON',
      '    ;;',
      '  *view*)',
      "    cat <<'JSON'",
      JSON.stringify(ISSUE),
      'JSON',
      '    ;;',
      `  *) ${ghFails ? 'exit 1' : 'echo ok'} ;;`,
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(join(bin, 'gh'), 0o755);

  writeFileSync(join(bin, 'adversarial-review'), `#!/bin/sh\necho "review $@" >> ${log}\nexit ${reviewExit}\n`);
  chmodSync(join(bin, 'adversarial-review'), 0o755);

  mkdirSync(join(dir, '.adlc'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (profile) writeFileSync(join(dir, '.claude', 'backlog-groom-profile.json'), JSON.stringify(profile));

  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cited.mjs'), 'const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed', '--no-gpg-sign');
  // A real remote-tracking ref: the floor's comparison ref is resolved from the
  // REPOSITORY, never from a flag, so the fixture has to provide the thing the
  // resolver looks for rather than pointing the tool at a branch of its choosing.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  // The hash the write path will recompute. Derived the same way the tool does,
  // so the fixture cannot drift from the implementation's definition of it.
  const hash = contentHash(['src/cited.mjs'], {
    readFile: (f) => spawnSync('git', ['show', `${head}:${f}`], { cwd: dir, encoding: 'utf8' }).stdout,
  });

  return { dir, bin, log, tmp, head, hash };
}

function run(args, { dir, bin, tmp }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp },
  });
}

/** The `backlog-groom-*` scratch directories currently in a sandbox's TMPDIR. */
const artifactDirs = (box) => readdirSync(box.tmp).filter((f) => f.startsWith('backlog-groom-'));

/**
 * The artifact paths the reviewer was handed, from the shim's log.
 *
 * The positive control for the cleanup tests: an empty sandbox TMPDIR proves
 * nothing unless the binary actually created its artifacts there.
 */
const reviewedArtifacts = (box) =>
  ghCalls(box)
    .filter((c) => c.startsWith('review'))
    .map((c) => c.split(/\s+/).find((t) => t.endsWith('.md')));

const ghCalls = (box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n').filter(Boolean) : []);

/**
 * Only the calls that CHANGE something.
 *
 * `issue view` is how the write path re-derives the set's claims, so a run that
 * reads several issues and writes nothing is the correct shape for a refusal —
 * asserting on every gh call would count those reads as writes.
 */
const ghWrites = (box) => ghCalls(box).filter((c) => /^issue (comment|close|edit)\b/.test(c));

/** A groomed set with exactly one closable issue. */
function setFile(box, { hash = box.hash } = {}) {
  const p = join(box.dir, 'groomed.json');
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 3,
      generatedFor: box.head,
      issues: [{ number: 705, verdict: 'fixed', contentHash: hash, evidence: 'the cited line is gone', updatedAt: '2026-09-01T00:00:00Z', frozen: false, labels: [], units: [] }],
      proposals: [],
    })
  );
  return p;
}

test('--apply without --set is refused before anything is spawned', () => {
  const box = sandbox();
  const r = run(['--apply'], box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--set/);
  assert.deepEqual(ghCalls(box), [], 'nothing may be invoked before the arguments are valid');
});

test('--apply with an unreadable set exits 1 and writes nothing', () => {
  const box = sandbox();
  const r = run(['--apply', '--set', join(box.dir, 'missing.json')], box);
  assert.equal(r.status, 1);
  assert.deepEqual(ghCalls(box), []);
});

test('with no declared providers the reviewer is never spawned and nothing is written', () => {
  // The default profile declares no providers, so the distinct-reviewer rule is
  // unsatisfiable and every action demotes. The run must still succeed.
  const box = sandbox();
  const set = setFile(box);
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ghWrites(box), [], 'no reviewer, no writes');
  assert.match(r.stderr, /demote/i);
  // git's own diagnostics must not leak into the operator's stderr. The default
  // runner pipes stdout and IGNORES stderr precisely so a missing profile at the
  // merge base — an ordinary, expected state — does not print a fatal-looking
  // git error beside a run that succeeded.
  assert.ok(!/fatal:|does not exist in/.test(r.stderr), `git noise leaked: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.executed.length, 0);
  assert.equal(out.proposed, 1, 'the run still reports what it would have done');
});

test('a floored close is never written, even with an approving reviewer', () => {
  // The default floor is ["close"], so this is the shipped-default behaviour: a
  // fresh adopter gets proposals, not closures.
  const box = sandbox({ reviewExit: 0, profile: { schemaVersion: 1, providers: { decider: 'anthropic', reviewer: 'openai' } } });
  const set = setFile(box);
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ghWrites(box), [], 'the floor must block the close');
  const out = JSON.parse(r.stdout);
  assert.equal(out.demoted[0].reason, 'floor');
});

test('an approved, unfloored close comments first and then closes', () => {
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 0, r.stderr);

  const calls = ghWrites(box);
  const commentAt = calls.findIndex((c) => c.startsWith('issue comment'));
  const closeAt = calls.findIndex((c) => c.startsWith('issue close'));
  assert.ok(commentAt >= 0, `expected a comment, got: ${JSON.stringify(calls)}`);
  // The run's own report carries `failed[].reason`, which is the only place a
  // comment that was logged and then failed says WHY — without it this
  // assertion reports the symptom and discards the cause.
  assert.ok(closeAt >= 0, `expected a close, got: ${JSON.stringify(calls)}\nrun output: ${r.stdout}`);
  assert.ok(commentAt < closeAt, 'the evidence must reach the issue before it goes quiet');
});

test('a reviewer that refuses blocks the close entirely', () => {
  const box = sandbox({
    reviewExit: 2,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ghWrites(box), [], 'a refused action leaves no trace');
});

test('a reviewer that ERRORS blocks the close — an error is not an approve', () => {
  const box = sandbox({
    reviewExit: 1,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ghWrites(box), []);
});

test('the gate ledger persists, so a second run does not re-review the same revision', () => {
  const box = sandbox({
    reviewExit: 2,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  run(['--apply', '--set', set], box);
  const afterFirst = ghCalls(box).filter((c) => c.startsWith('review')).length;
  assert.equal(afterFirst, 1);

  run(['--apply', '--set', set], box);
  const afterSecond = ghCalls(box).filter((c) => c.startsWith('review')).length;
  assert.equal(afterSecond, 1, 'the same revision must not be reviewed twice across runs');
});

test('apply works in a repository that has no .adlc directory yet', () => {
  // The documented command must work on a repo that has not adopted ADLC; the
  // ledger's parent is created rather than assumed.
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  rmSync(join(box.dir, '.adlc'), { recursive: true, force: true });
  const r = run(['--apply', '--set', setFile(box)], box);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(box.dir, '.adlc', 'backlog-groom-ledger.json')), 'the ledger must have been created');
});

test('an unwritable ledger FAILS the run rather than warning', () => {
  // The cache warns and continues because a lost cache costs a slow run. The
  // ledger is the only record that a revision has spent its one review, so a
  // decision that cannot be persisted is authorization the next run will not
  // see — and continuing would act on it anyway.
  const box = sandbox({
    reviewExit: 2,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  // .adlc replaced by a FILE, so neither the parent mkdir nor the ledger write
  // can succeed. (Removing the directory no longer suffices: the CLI creates it,
  // which is the documented behaviour on a repo that has not adopted ADLC.)
  rmSync(join(box.dir, '.adlc'), { recursive: true, force: true });
  writeFileSync(join(box.dir, '.adlc'), 'not a directory\n');
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ledger/i);
  assert.deepEqual(ghWrites(box), [], 'nothing may be written');
});

test('a corrupt ledger refuses the run instead of starting from empty', () => {
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  writeFileSync(join(box.dir, '.adlc', 'backlog-groom-ledger.json'), '{ truncated');
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 1);
  assert.deepEqual(ghWrites(box), [], 'a ledger that cannot prove a revision was reviewed must stop the run');
});

test('a held apply lock refuses a concurrent run', () => {
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const set = setFile(box);
  mkdirSync(join(box.dir, '.adlc', 'backlog-groom-ledger.json.lock'), { recursive: true });
  const r = run(['--apply', '--set', set], box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lock/i);
  assert.deepEqual(ghWrites(box), []);
});

test('a set generated for a different revision is refused', () => {
  // Acting on a stale set closes issues on evidence that no longer describes the
  // code: the cited file may have changed, or the defect been reintroduced.
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const p = join(box.dir, 'stale.json');
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 3,
      generatedFor: '0000000000000000000000000000000000000000',
      issues: [{ number: 705, verdict: 'fixed', contentHash: 'h1', evidence: 'gone', updatedAt: '2026-09-01T00:00:00Z', frozen: false, labels: [], units: [] }],
      proposals: [],
    })
  );
  const r = run(['--apply', '--set', p], box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /generated for/i);
  assert.deepEqual(ghWrites(box), []);
});

test('an issue whose cited paths are frozen is never auto-actioned', () => {
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const p = join(box.dir, 'frozen.json');
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 3,
      generatedFor: box.head,
      issues: [{ number: 705, verdict: 'fixed', contentHash: box.hash, evidence: 'gone', updatedAt: '2026-09-01T00:00:00Z', frozen: true, labels: [], units: [] }],
      proposals: [],
    })
  );
  const r = run(['--apply', '--set', p], box);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ghWrites(box), [], 'a frozen path means no action at all, not even a review');
});

test('the apply path exposes no way to choose the floor comparison ref', () => {
  // A caller who picks the ref can pick HEAD, which makes the merge base the
  // working copy: a floor widened to [] then compares equal to itself and is
  // accepted. The flag is gone, and an attempt to pass it is an argument error
  // rather than a silently ignored option.
  const box = sandbox();
  const set = setFile(box);
  const r = run(['--apply', '--set', set, '--base-ref', 'HEAD'], box);
  assert.equal(r.status, 1);
  assert.deepEqual(ghCalls(box), [], 'nothing may be written on an argument error');
});

test('each action is reviewed with its OWN artifact, not the whole set', () => {
  // A reviewer handed the whole set returns one verdict for the batch, and
  // treating that as authorization for each action means an approve never
  // confirmed the specific write being executed.
  const box = sandbox({
    reviewExit: 2,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const p = join(box.dir, 'groomed.json');
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 3,
      generatedFor: box.head,
      issues: [
        { number: 705, verdict: 'fixed', contentHash: box.hash, evidence: 'gone', updatedAt: '2026-09-01T00:00:00Z', frozen: false, labels: [], units: [] },
        { number: 706, verdict: 'fixed', contentHash: box.hash, evidence: 'also gone', updatedAt: '2026-09-01T00:00:00Z', frozen: false, labels: [], units: [] },
      ],
      proposals: [],
    })
  );
  run(['--apply', '--set', p], box);
  const reviews = ghCalls(box).filter((c) => c.startsWith('review'));
  assert.equal(reviews.length, 2, 'one review per action');
  // Each review names a different artifact, and neither is the groomed set.
  const paths = reviews.map((r) => r.split(/\s+/).find((t) => t.endsWith('.md')));
  assert.equal(new Set(paths).size, 2, `each action needs its own artifact, got ${JSON.stringify(paths)}`);
  assert.ok(paths.every((x) => x && !x.endsWith('groomed.json')));
});

test('a set whose claimed verdict does not survive re-verification is refused', () => {
  // The fixture issue's cited snippet is genuinely absent, so it re-verifies as
  // `fixed`. Claiming `fixed` for an issue whose defect is still present must
  // not close it — matching bytes prove the set describes the right thing and
  // say nothing about whether its conclusion is right.
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const p = join(box.dir, 'lying.json');
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 4,
      generatedFor: box.head,
      // A stale issue revision: the live issue says 2026-09-01.
      issues: [{ number: 705, verdict: 'fixed', contentHash: box.hash, evidence: 'gone', updatedAt: '2020-01-01T00:00:00Z', frozen: false, labels: [], units: [] }],
      proposals: [],
    })
  );
  const r = run(['--apply', '--set', p], box);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ghWrites(box), [], 'an issue that changed since grooming must not be actioned');
  assert.match(r.stdout, /changed since the set was generated/);
});

test('an apply run leaves no artifact directory behind', () => {
  // The leak that exhausted every inode on /tmp while df reported 41% used. A
  // scheduled sweep runs this repeatedly, so "cleans up eventually" is not a
  // property — it either removes its scratch or it accumulates forever.
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  const r = run(['--apply', '--set', setFile(box)], box);
  assert.equal(r.status, 0, r.stderr);
  const [artifact] = reviewedArtifacts(box);
  assert.ok(artifact?.startsWith(box.tmp), `the artifact must have been written under the sandbox TMPDIR, got ${artifact}`);
  assert.equal(existsSync(dirname(artifact)), false, 'the per-run artifact directory must be removed');
  assert.deepEqual(artifactDirs(box), []);
});

test('the ledger path is fixed, so a caller cannot reset the one-shot rule', () => {
  // A caller-chosen ledger is a one-shot rule the caller can forget: point at a
  // fresh file and every spent review is available again.
  const box = sandbox();
  const r = run(['--apply', '--set', setFile(box), '--ledger', '/tmp/elsewhere.json'], box);
  assert.equal(r.status, 1, 'the flag must not exist');
  assert.deepEqual(ghWrites(box), []);
});

test('a failed apply still clears its artifact directory', () => {
  // The failure branch is the one that has been running long enough to have
  // written artifacts, and a scheduled sweep that fails repeatedly leaks fastest.
  //
  // The run must GENUINELY fail, and fail after an artifact exists. This test
  // previously rewrote the profile with the same `autonomyFloor: []` the sandbox
  // had already committed, so nothing was widened, the run exited 0, and it
  // re-tested the success path under a failure-path name. Here the reviewer
  // replaces the ledger file with a directory while it reviews, so the
  // checkpoint that follows every gate decision throws — after the artifact was
  // written and handed over, before any write to GitHub.
  const box = sandbox({
    reviewExit: 0,
    profile: { schemaVersion: 1, autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } },
  });
  writeFileSync(
    join(box.bin, 'adversarial-review'),
    `#!/bin/sh\necho "review $@" >> ${box.log}\nrm -f .adlc/backlog-groom-ledger.json\nmkdir .adlc/backlog-groom-ledger.json\nexit 0\n`
  );
  const r = run(['--apply', '--set', setFile(box)], box);
  assert.equal(r.status, 1, `the run must fail, got exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /could not persist the gate ledger/);
  const [artifact] = reviewedArtifacts(box);
  assert.ok(artifact?.startsWith(box.tmp), `the artifact must have been written under the sandbox TMPDIR, got ${artifact}`);
  assert.equal(existsSync(dirname(artifact)), false, `artifact dir leaked on exit ${r.status}`);
  assert.deepEqual(artifactDirs(box), []);
  assert.deepEqual(ghWrites(box), [], 'a run that cannot record its authorization writes nothing');
});
