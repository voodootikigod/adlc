// Concern: bin/adlc-prosecute.mjs tier-check — the changed-file set fed to
// classifyTrustRootTier must be the change's OWN files (diffed against the
// merge-base of --base and HEAD), never base-side churn from a base branch that
// advanced after the branch point (T-01M00BNADHBEP8N4VPG9J84V8W).
//
// The defect this pins against: a two-dot diff vs the base TIP reports every file
// the base changed since the branch point as a reversed difference, so a PR behind
// a busy main tiers trust-root on files it never touched (PR #493 tiered on
// packages/**, plugins/**, .github/workflows/** while only adding ticket shards).
//
// Properties pinned, end-to-end at the process boundary in a real git repo:
//   - AC1: base-side churn in an enforcement package does NOT tier the change;
//   - AC1: base-side churn on a ticket rails deny-path does NOT tier the change;
//   - the change's OWN trust-root edit still tiers with churn present (committed),
//     and an UNCOMMITTED trust-root edit still tiers (FIX A composed with the
//     merge-base anchor);
//   - AC5: a --base that resolves but shares no history (no merge-base) fails
//     closed (exit 1) with the actionable changed-file-set message.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

// tier-check verifies attestation signatures once a change tiers; give subprocesses
// a key so a tiered fixture fails for "no attestation", never for "no key".
process.env.ADLC_MANIFEST_KEY = 'test-tier-merge-base-signing-key';

function runBin(args, cwd, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const PINNED_GIT_DATE = '2026-01-01T00:00:00Z';

// Scratch repo shaped like the false-positive scenario: baseline on main (with a
// base ticket whose rails cover src/**), a feat branch carrying only mutate(dir),
// then main ADVANCES with advanceBase(dir) — churn the feat branch never touched —
// and the checkout returns to feat, which is now BEHIND main.
function scratchRepo({ baseTickets, mutate, advanceBase }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-tier-merge-base-'));
  const g = (...a) => execFileSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: PINNED_GIT_DATE, GIT_COMMITTER_DATE: PINNED_GIT_DATE },
  });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: baseTickets }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 0;\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'note.md'), 'docs baseline\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  mutate(dir, g);
  g('add', '-A'); g('commit', '-qm', 'feat change');
  if (advanceBase) {
    g('checkout', '-q', 'main');
    advanceBase(dir, g);
    g('add', '-A'); g('commit', '-qm', 'main advances after the branch point');
    g('checkout', '-q', 'feat');
  }
  return { dir, g };
}

const T = (over = {}) => ({ id: 'T1', title: 'x', scope: ['src/**'], rails: ['src/**'], edges: [], ...over });
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const benignDocsEdit = (d) => writeFileSync(join(d, 'docs', 'note.md'), 'edited on feat\n');

describe('adlc-prosecute tier-check anchors the diff to the merge-base (T-01M00BNADHBEP8N4VPG9J84V8W)', () => {
  it('AC1: enforcement-package churn on the ADVANCED BASE does not tier a change that never touched it', () => {
    const { dir } = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: benignDocsEdit,
      advanceBase: (d) => {
        mkdirSync(join(d, 'packages', 'prosecute', 'lib'), { recursive: true });
        writeFileSync(join(d, 'packages', 'prosecute', 'lib', 'churn.mjs'), 'export const churn = 1;\n');
      },
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 0, `base-side churn must not tier the change: ${r.stderr}`);
      assert.match(r.stdout, /NOT trust-root tier/);
    } finally { cleanup(dir); }
  });

  it('AC1: ticket rails deny-path churn on the ADVANCED BASE does not tier a change that never touched it', () => {
    const { dir } = scratchRepo({
      baseTickets: [T()], // rails: src/**
      mutate: benignDocsEdit,
      advanceBase: (d) => writeFileSync(join(d, 'src', 'app.mjs'), 'export const x = 1; // changed on main\n'),
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 0, `a rail the change never touched must not tier it: ${r.stderr}`);
      assert.match(r.stdout, /NOT trust-root tier/);
    } finally { cleanup(dir); }
  });

  it('the change’s OWN enforcement-package edit still tiers when base churn is also present', () => {
    const { dir } = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: (d) => {
        mkdirSync(join(d, 'packages', 'gate-manifest', 'lib'), { recursive: true });
        writeFileSync(join(d, 'packages', 'gate-manifest', 'lib', 'mine.mjs'), 'export const mine = 1;\n');
      },
      advanceBase: (d) => writeFileSync(join(d, 'README.md'), 'churn on main\n'),
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 2, 'the change’s own trust-root edit must still tier');
      assert.match(r.stderr, /packages\/gate-manifest\//, 'the reason names the change’s own file');
      assert.doesNotMatch(r.stderr, /README/, 'and never the base-side churn');
    } finally { cleanup(dir); }
  });

  it('FIX A composed with the merge-base anchor: an UNCOMMITTED trust-root edit still tiers', () => {
    const { dir } = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: benignDocsEdit,
      advanceBase: (d) => writeFileSync(join(d, 'README.md'), 'churn on main\n'),
    });
    try {
      mkdirSync(join(dir, 'packages', 'rails-guard', 'lib'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'rails-guard', 'lib', 'uncommitted.mjs'), 'export const u = 1;\n');
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 2, 'an uncommitted trust-root edit must still tier — the diff stays working-tree-inclusive');
      assert.match(r.stderr, /packages\/rails-guard\//);
    } finally { cleanup(dir); }
  });

  it('the --help contract documents the merge-base basis, not the base tip', () => {
    // The help text is the CLI's user-facing contract for HOW the tier's
    // changed-file set is computed; an operator follows it when CI fails. Pin the
    // merge-base anchor so the documented basis cannot silently drift from the
    // implemented one (this also makes the help text mutation-visible).
    const r = runBin(['--help'], tmpdir());
    assert.equal(r.status, 0);
    assert.match(r.stdout, /MERGE-BASE of <base> and HEAD/);
    assert.match(r.stdout, /git diff --name-only <merge-base>/);
  });

  it('criss-cross histories (multiple best common ancestors) fail closed (exit 1), never an arbitrary basis', () => {
    // After mutual merges, main and feat share TWO best common ancestors —
    // `git merge-base --all` prints both. Bare `merge-base` would silently pick
    // one, making the tier basis (and what tiers) depend on an anchor nobody
    // chose; the gate must refuse instead.
    const { dir, g } = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: benignDocsEdit,
    });
    try {
      const shaFeat = g('rev-parse', 'HEAD').trim();
      g('checkout', '-q', 'main');
      writeFileSync(join(dir, 'main-side.txt'), 'Y\n');
      g('add', '-A'); g('commit', '-qm', 'Y');
      g('checkout', '-q', 'feat');
      g('merge', '-q', '--no-edit', 'main');
      g('checkout', '-q', 'main');
      g('merge', '-q', '--no-edit', shaFeat);
      g('checkout', '-q', 'feat');
      const all = g('merge-base', '--all', 'main', 'HEAD').trim().split('\n');
      assert.equal(all.length, 2, 'precondition: the topology really has two best ancestors');
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 1, 'an ambiguous merge-base must refuse the run');
      assert.match(r.stderr, /cannot determine the changed-file set/);
    } finally { cleanup(dir); }
  });

  it('AC5: a --base that resolves but shares NO history fails closed (exit 1), never an ungated pass', () => {
    const { dir, g } = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: benignDocsEdit,
    });
    try {
      // An orphan branch: rev-parse resolves it, but merge-base with feat does not exist.
      g('checkout', '-q', '--orphan', 'isolated');
      writeFileSync(join(dir, 'island.txt'), 'no shared history\n');
      g('add', '-A'); g('commit', '-qm', 'orphan');
      g('checkout', '-q', 'feat');
      const r = runBin(['tier-check', '--base', 'isolated', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 1, 'no merge-base ⇒ the changed-file set cannot be determined ⇒ refuse the run');
      assert.match(r.stderr, /cannot determine the changed-file set/);
      assert.match(r.stderr, /--base <ref>/);
    } finally { cleanup(dir); }
  });
});
