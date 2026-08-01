// enable.test.mjs — the greenfield forest-mode activation command
// (T-01KYZ0C7BB3BD36J0MKAA110PV, docs/specs/segmented-gate-manifest.md
// 'Storage modes'). Single-file and segmented are both permanent supported
// modes; `enable` is the missing greenfield switch into the second one.
//
// Every refusal here is exit 2 (gate fail) and must leave the filesystem
// byte-identical — an activation command that half-writes on refusal would
// manufacture exactly the broken states it exists to refuse.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planEnable, enable, MARKER_NEGATION_LINES } from '../lib/enable.mjs';
import { isSegmentedRepo, markerPath } from '../lib/lineage.mjs';
import { appendManifestEntry } from '../lib/record.mjs';
import { readRawLines } from '../lib/forest.mjs';
import { isSegmentedRepo as ticketsIsSegmentedRepo } from '../../tickets/lib/manifest-segments.mjs';

const BIN = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;

// A real git repo fixture: the gitignore-committability probe (AC10) only
// means something inside an actual repository.
function gitRepo({ gitignore = null, init = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-manifest-enable-'));
  if (init) {
    const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-q', '-b', 'feat/enable');
    g('config', 'user.email', 't@t.co');
    g('config', 'user.name', 'tester');
    g('config', 'commit.gpgsign', 'false');
  }
  if (gitignore !== null) writeFileSync(join(root, '.gitignore'), gitignore);
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

// The ADLC repo's own negation block — the reference committable shape.
const NEGATED = '.adlc/*\n!.adlc/manifest.jsonl\n!.adlc/manifest.d/\n!.adlc/manifest.d/**\n.adlc/manifest.d/.lineage\n.adlc/manifest.d/*.lock\n';
// The broken init-defaults shape: everything under .adlc ignored, no negations.
const IGNORED = '.adlc/*\n';

function clean(root) { rmSync(root, { recursive: true, force: true }); }

function runBin(root, ...args) {
  // Ambient trust-root env must not leak into the spawned CLI (repo standard
  // since the runner scrub landed) — enable needs no key anyway.
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  return spawnSync(process.execPath, [BIN, 'enable', ...args], { cwd: root, encoding: 'utf8', env });
}

function snapshot(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { recursive: true }).sort();
}

describe('planEnable decision order (spec Storage modes; ticket work item 1h)', () => {
  it('refuses when no .adlc workspace exists — never creates one as a side effect', () => {
    const { root } = gitRepo();
    rmSync(join(root, '.adlc'), { recursive: true });
    try {
      const plan = planEnable(join(root, '.adlc'), { cwd: root });
      assert.equal(plan.decision, 'refuse-no-workspace');
      assert.match(plan.reason, /adlc-init|init/);
      assert.equal(existsSync(join(root, '.adlc')), false, 'planning must not create the workspace');
    } finally { clean(root); }
  });

  it('reports already-enabled for a marker-carrying repo', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      writeFileSync(markerPath(dir), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
      const plan = planEnable(dir, { cwd: root });
      assert.equal(plan.decision, 'already-enabled');
    } finally { clean(root); }
  });

  it('AC4: reports already-enabled for a cutover-tailed root with a MISSING marker — never tells a cut-over repo to re-run a ceremony it already ran', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      writeFileSync(join(dir, 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'manifest-cutover', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null })}\n`);
      const plan = planEnable(dir, { cwd: root });
      assert.equal(plan.decision, 'already-enabled');
    } finally { clean(root); }
  });

  it('AC4: refuses a manifest.d/ that has content but no valid marker (broken state to surface, not silently repair)', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      writeFileSync(join(dir, 'manifest.d', 'feat-enable-01HZZZZZZZZZZZZZZZZZZZZZZZ.jsonl'), '{"seq":1}\n');
      const plan = planEnable(dir, { cwd: root });
      assert.equal(plan.decision, 'refuse-broken-manifest-dir');
    } finally { clean(root); }
  });

  it('AC2: refuses a live (non-empty, non-cutover) root, naming the cutover ceremony ticket', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      writeFileSync(join(dir, 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null })}\n`);
      const plan = planEnable(dir, { cwd: root });
      assert.equal(plan.decision, 'refuse-live-root');
      assert.match(plan.reason, /T-MANIFEST-FOREST-MIGRATE/);
    } finally { clean(root); }
  });

  it('AC10: refuses when the marker path is gitignored — an ignored marker silently reverts every other checkout to single-file mode', () => {
    const { root, dir } = gitRepo({ gitignore: IGNORED });
    try {
      const plan = planEnable(dir, { cwd: root });
      assert.equal(plan.decision, 'refuse-ignored');
      assert.match(plan.reason, /!\.adlc\/manifest\.d\//, 'the refusal must name the exact negation lines to add');
      assert.equal(existsSync(join(dir, 'manifest.d')), false, 'the dry-run probe must not create the directory');
    } finally { clean(root); }
  });

  it('proceeds greenfield with an ABSENT root, with an EMPTY root, with negations present, and with no .gitignore at all', () => {
    for (const gitignore of [NEGATED, null]) {
      for (const emptyRoot of [false, true]) {
        const { root, dir } = gitRepo({ gitignore });
        try {
          if (emptyRoot) writeFileSync(join(dir, 'manifest.jsonl'), '');
          const plan = planEnable(dir, { cwd: root });
          assert.equal(plan.decision, 'greenfield', `gitignore=${gitignore === null ? 'none' : 'negated'} emptyRoot=${emptyRoot}`);
          assert.equal(plan.marker.format, 'adlc-manifest-segments');
          assert.equal(plan.marker.version, 1);
        } finally { clean(root); }
      }
    }
  });

  it('proceeds outside a git repository — evidence without git is supported, so the probe soft-passes', () => {
    const { root, dir } = gitRepo({ init: false });
    try {
      const plan = planEnable(dir, { cwd: root });
      assert.equal(plan.decision, 'greenfield');
    } finally { clean(root); }
  });
});

describe('enable() write path (AC1, AC3, AC4)', () => {
  it('AC3: dry-run (write: false) changes nothing on disk', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      const before = snapshot(dir);
      const out = enable(dir, { cwd: root, write: false });
      assert.equal(out.decision, 'greenfield');
      assert.equal(out.written, false);
      assert.deepEqual(snapshot(dir), before, 'dry-run must not touch the filesystem');
      assert.equal(isSegmentedRepo(dir), false);
    } finally { clean(root); }
  });

  it('AC1: write flips the repo to forest mode, recognized by BOTH packages, and the next append writes a segment, not root', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      const out = enable(dir, { cwd: root, write: true });
      assert.equal(out.decision, 'greenfield');
      assert.equal(out.written, true);
      assert.equal(isSegmentedRepo(dir), true, 'gate-manifest must recognize the marker it wrote');
      assert.equal(ticketsIsSegmentedRepo(dir), true, 'the tickets-package twin must recognize the SAME marker — cross-package recognition is asserted, not assumed');

      appendManifestEntry({ gate: 'evidence', data: { note: 'first' } }, dir, { cwd: root, key: 'enable-test-key' });
      const rootLines = readRawLines(join(dir, 'manifest.jsonl'));
      assert.equal(rootLines.length, 0, 'root must stay empty — the append went to a segment');
      const segs = readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl'));
      assert.equal(segs.length, 1, 'exactly one segment holds the append');
    } finally { clean(root); }
  });

  it('AC4: idempotent — a second enable exits already-enabled and leaves the marker bytes untouched', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      enable(dir, { cwd: root, write: true });
      const bytes = readFileSync(markerPath(dir));
      const out = enable(dir, { cwd: root, write: true });
      assert.equal(out.decision, 'already-enabled');
      assert.equal(out.written, false);
      assert.deepEqual(readFileSync(markerPath(dir)), bytes, 'the marker must not be rewritten');
    } finally { clean(root); }
  });

  it('AC10: the remediation advice WORKS for BOTH ignore styles — appending exactly the advertised negation lines converts the refusal into a committable enable', () => {
    // `.adlc/*` needs only the directory negation; `.adlc/**` matches
    // descendants directly and needs the descendant negation too — the
    // advertised set must be sufficient for BOTH (adversarial-review
    // finding: a one-line advice left `.adlc/**` repos stuck refusing).
    for (const style of ['.adlc/*\n', '.adlc/**\n']) {
      const { root, dir } = gitRepo({ gitignore: style });
      try {
        assert.equal(enable(dir, { cwd: root, write: true }).decision, 'refuse-ignored', `style=${style.trim()}`);
        // Follow the advice verbatim — the exported lines ARE the advice; if
        // they shrink or drift, this stops converting the refusal and fails.
        writeFileSync(join(root, '.gitignore'), style + MARKER_NEGATION_LINES.join('\n') + '\n');
        const out = enable(dir, { cwd: root, write: true });
        assert.equal(out.decision, 'greenfield', `style=${style.trim()}`);
        assert.equal(out.written, true);
        // The advice's whole point: the marker must now actually be stageable.
        const r = spawnSync('git', ['check-ignore', '-q', '--', '.adlc/manifest.d/.store.json'], { cwd: root });
        assert.equal(r.status, 1, `the written marker must NOT be gitignored after following the advice (style=${style.trim()})`);
      } finally { clean(root); }
    }
  });

  it('AC10: a marker-SPECIFIC ignore rule refuses even though the directory probe alone would pass', () => {
    const { root, dir } = gitRepo({ gitignore: '.adlc/manifest.d/.store.json\n' });
    try {
      const out = enable(dir, { cwd: root, write: true });
      assert.equal(out.decision, 'refuse-ignored', 'the FILE path must be probed, not just the directory');
      assert.equal(out.written, false);
      assert.equal(existsSync(join(dir, 'manifest.d')), false);
    } finally { clean(root); }
  });

  it('the gitignore probe never leaks the manifest key or GIT_* repo selectors to the git child', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    const shimDir = mkdtempSync(join(tmpdir(), 'git-shim-'));
    const envDump = join(shimDir, 'env-dump.txt');
    // A PATH-resolved git shim that records its environment, then behaves
    // like real git enough for the probe: rev-parse succeeds, check-ignore
    // reports "no pattern matches".
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nenv > "${envDump}"\ncase "$1" in rev-parse) exit 0;; check-ignore) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
    const prevPath = process.env.PATH;
    const prevKey = process.env.ADLC_MANIFEST_KEY;
    const prevGitDir = process.env.GIT_DIR;
    try {
      process.env.PATH = `${shimDir}:${prevPath}`;
      process.env.ADLC_MANIFEST_KEY = 'super-secret-trust-root-key';
      process.env.GIT_DIR = '/tmp/nonexistent-elsewhere/.git';
      const plan = planEnable(dir, { cwd: root });
      assert.equal(plan.decision, 'greenfield', 'the shim answered like clean git, so the probe proceeds');
      const dumped = readFileSync(envDump, 'utf8');
      assert.ok(!dumped.includes('super-secret-trust-root-key'), 'the git child must never see the manifest key');
      assert.ok(!dumped.includes('ADLC_MANIFEST_KEY'), 'the variable itself must be absent, not just emptied');
      assert.ok(!dumped.includes('GIT_DIR='), 'GIT_* repo selectors must not redirect the probe');
    } finally {
      process.env.PATH = prevPath;
      if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = prevKey;
      if (prevGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevGitDir;
      clean(root); clean(shimDir);
    }
  });

  it('the marker is published under the root-ledger lock — a held lock blocks enable instead of racing a concurrent root append', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      // Hold the exact lock root appendEntries takes (ledgerPath + .lock).
      writeFileSync(join(dir, 'manifest.jsonl.lock'), JSON.stringify({ version: 1, token: 'held-by-test', pid: 0 }));
      assert.throws(
        () => enable(dir, { cwd: root, write: true }),
        /lock/i,
        'enable must contend for the root ledger lock, not transition around a mid-append writer',
      );
      assert.equal(existsSync(markerPath(dir)), false, 'no marker may appear while the lock was held');
    } finally { clean(root); }
  });

  it('refusals write nothing even with write: true', () => {
    const { root, dir } = gitRepo({ gitignore: IGNORED });
    try {
      const before = snapshot(dir);
      const out = enable(dir, { cwd: root, write: true });
      assert.equal(out.decision, 'refuse-ignored');
      assert.equal(out.written, false);
      assert.deepEqual(snapshot(dir), before);
    } finally { clean(root); }
  });
});

describe('gate-manifest enable CLI (AC2, AC3, AC10, AC11)', () => {
  it('dry-run greenfield: exit 0, plan on stdout, nothing created', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      const r = runBin(root);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /dry-run|--write/i, 'the plan must say how to apply it');
      assert.equal(existsSync(join(dir, 'manifest.d')), false);
    } finally { clean(root); }
  });

  it('--write greenfield: exit 0, marker exists afterwards', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      const r = runBin(root, '--write');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(isSegmentedRepo(dir), true);
    } finally { clean(root); }
  });

  it('AC2: live root refuses with exit 2, stderr names the cutover ceremony, and creates nothing', () => {
    const { root, dir } = gitRepo({ gitignore: NEGATED });
    try {
      writeFileSync(join(dir, 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null })}\n`);
      for (const args of [[], ['--write']]) {
        const r = runBin(root, ...args);
        assert.equal(r.status, 2, `args=${args.join(' ')}`);
        assert.match(r.stderr, /T-MANIFEST-FOREST-MIGRATE/);
        assert.equal(existsSync(join(dir, 'manifest.d')), false);
      }
    } finally { clean(root); }
  });

  it('AC10: gitignored marker refuses with exit 2 in BOTH modes and creates nothing', () => {
    const { root, dir } = gitRepo({ gitignore: IGNORED });
    try {
      for (const args of [[], ['--write']]) {
        const r = runBin(root, ...args);
        assert.equal(r.status, 2, `args=${args.join(' ')}`);
        assert.match(r.stderr, /!\.adlc\/manifest\.d\//);
        assert.equal(existsSync(join(dir, 'manifest.d')), false);
      }
    } finally { clean(root); }
  });

  it('no workspace: exit 2 pointing at init', () => {
    const { root } = gitRepo();
    rmSync(join(root, '.adlc'), { recursive: true });
    try {
      const r = runBin(root);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /init/);
      assert.equal(existsSync(join(root, '.adlc')), false);
    } finally { clean(root); }
  });

  it('AC11: --json emits exactly one parseable document — dry-run, write, and refusal alike', () => {
    const cases = [
      { gitignore: NEGATED, args: ['--json'], status: 0, decision: 'greenfield' },
      { gitignore: NEGATED, args: ['--write', '--json'], status: 0, decision: 'greenfield' },
      { gitignore: IGNORED, args: ['--write', '--json'], status: 2, decision: 'refuse-ignored' },
    ];
    for (const c of cases) {
      const { root } = gitRepo({ gitignore: c.gitignore });
      try {
        const r = runBin(root, ...c.args);
        assert.equal(r.status, c.status, `${c.args.join(' ')}: ${r.stderr}`);
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, `FULL stdout must be one JSON document for ${c.args.join(' ')}`);
        assert.equal(parsed.decision, c.decision);
      } finally { clean(root); }
    }
  });
});
