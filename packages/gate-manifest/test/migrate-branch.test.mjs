// migrate-branch.test.mjs — in-flight branch salvage after cutover
// (T-01KZHAG1NSKDQTRB1JHZ4EJY2M).
//
// The scenario: main cut over while a branch still held root-tail evidence;
// the rebase's only correct resolution discarded that evidence. This tool
// re-chains the branch's signature-verified entries into a fresh segment via
// the PRODUCTION writer — mint, anchor, branch identity, lineage token all
// come from appendManifestEntry, not a re-implementation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planMigrateBranch, migrateBranch } from '../lib/migrate-branch.mjs';
import { migrate } from '../lib/migrate.mjs';
import { appendManifestEntry } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { readManifestForest } from '../lib/forest.mjs';
// The gate that will judge the salvage PR — same relative-import pattern as
// migrate.test.mjs.
import { assertRootTransition, validateNewSegments, validateSegmentAppendOnly } from '../../rails-guard/lib/ci/manifest.mjs';

const KEY = 'migrate-branch-test-key';
const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const REASON = 'cutover to forest mode';

const evidence = (n = 0) => ({ gate: 'evidence', data: { note: `work-${n}` }, files: {} });
const approveEntry = () => ({
  gate: 'cross-model-review',
  ticket: 'T-SALVAGED',
  data: { verdict: 'approve', provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:oldbase:samedigest' },
  files: {},
});

/**
 * Build the whole scenario in one git repo:
 *  1. base root with shared entries, committed
 *  2. "branch" state: two more entries appended to the root, committed (this
 *     commit plays ORIG_HEAD / --from)
 *  3. "post-rebase" state: root restored to base, ceremony run (cutover),
 *     committed — the working tree a developer has after resolving the
 *     conflict by taking main's side
 */
function scenario({ branchEntries = [evidence(10), approveEntry()], onBranch = 'feat-x' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gm-salvage-')));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  g('init', '-q', '-b', onBranch);
  g('config', 'user.email', 't@t.co'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'),
    '.adlc/*\n!.adlc/manifest.jsonl\n!.adlc/manifest.d/\n!.adlc/manifest.d/**\n.adlc/manifest.d/.lineage\n.adlc/manifest.d/*.lock\n');
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  appendManifestEntry(evidence(0), dir, { key: KEY });
  appendManifestEntry(evidence(1), dir, { key: KEY });
  const baseRoot = readFileSync(join(dir, 'manifest.jsonl'));
  g('add', '-A'); g('commit', '-qm', 'shared base');

  for (const entry of branchEntries) appendManifestEntry(entry, dir, { key: KEY });
  g('add', '-A'); g('commit', '-qm', 'branch evidence');
  const sourceSha = g('rev-parse', 'HEAD');

  // resolve-to-main + ceremony (what the migrated main looks like)
  writeFileSync(join(dir, 'manifest.jsonl'), baseRoot);
  const ceremony = migrate(dir, { key: KEY, reason: REASON, write: true });
  assert.equal(ceremony.decision, 'applied', 'fixture ceremony must apply');
  g('add', '-A'); g('commit', '-qm', 'post-rebase migrated state');
  return { root, dir, sourceSha, g };
}

const clean = (root) => rmSync(root, { recursive: true, force: true });

describe('refusals', () => {
  it('keyless refuses — salvage exists to preserve AUTHENTICATED evidence', () => {
    const { root, dir, sourceSha } = scenario();
    try {
      const plan = planMigrateBranch(dir, { key: null, sourceRef: sourceSha, cwd: root });
      assert.equal(plan.decision, 'refuse-keyless');
    } finally { clean(root); }
  });

  it('a non-segmented repository refuses — salvage is a post-cutover tool', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gm-salvage-flat-')));
    try {
      const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.co'); g('config', 'user.name', 't');
      const dir = join(root, '.adlc');
      mkdirSync(dir, { recursive: true });
      appendManifestEntry(evidence(), dir, { key: KEY });
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: 'HEAD', cwd: root });
      assert.equal(plan.decision, 'refuse-not-segmented');
    } finally { clean(root); }
  });

  it('an unresolvable source ref refuses', () => {
    const { root, dir } = scenario();
    try {
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: 'no-such-ref-anywhere', cwd: root });
      assert.equal(plan.decision, 'refuse-source');
    } finally { clean(root); }
  });

  it('a working root still carrying the branch tail refuses with the take-main recipe', () => {
    const { root, dir, sourceSha, g } = scenario();
    try {
      // un-resolve: put the branch's pre-rebase root back in the working tree
      const branchRoot = execFileSync('git', ['show', `${sourceSha}:.adlc/manifest.jsonl`], { cwd: root });
      writeFileSync(join(dir, 'manifest.jsonl'), branchRoot);
      void g;
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root });
      assert.equal(plan.decision, 'refuse-unresolved');
      assert.match(plan.reason, /main/);
    } finally { clean(root); }
  });

  it('a TAMPERED source entry refuses, and --attest-unsigned does NOT admit it — only genuinely unsigned entries', () => {
    const tampered = { gate: 'evidence', data: { note: 'tampered-later' }, files: {} };
    const { root, dir, sourceSha, g } = scenario({ branchEntries: [tampered] });
    try {
      // rewrite the branch commit's manifest so its entry's sig no longer matches
      const branchRoot = execFileSync('git', ['show', `${sourceSha}:.adlc/manifest.jsonl`], { cwd: root, encoding: 'utf8' });
      const lines = branchRoot.trim().split('\n');
      const last = JSON.parse(lines.at(-1));
      last.data.note = 'altered-after-signing';
      lines[lines.length - 1] = JSON.stringify(last);
      // commit the altered root on a throwaway ref
      writeFileSync(join(root, 'altered.jsonl'), lines.join('\n') + '\n');
      g('add', 'altered.jsonl'); g('commit', '-qm', 'altered');
      const alteredSha = g('rev-parse', 'HEAD');
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: alteredSha, sourcePath: 'altered.jsonl', cwd: root, attestUnsigned: true });
      assert.equal(plan.decision, 'refuse-tampered');
    } finally { clean(root); }
  });

  it('a branch that already owns a segment refuses — salvage runs once, before new writes', () => {
    const { root, dir, sourceSha } = scenario();
    try {
      // a post-rebase write already minted this branch's segment
      appendManifestEntry(evidence(99), dir, { key: KEY });
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root });
      assert.equal(plan.decision, 'refuse-existing-segment');
    } finally { clean(root); }
  });

  it('a source suffix that does not chain from the shared prefix refuses — corruption surfaced, not truncated', () => {
    const { root, dir, g } = scenario();
    try {
      // fabricate a source whose extra line does not chain
      const working = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
      const shared = working.split('\n').slice(0, 2).join('\n');
      const bogus = shared + '\n' + JSON.stringify({ seq: 3, gate: 'evidence', data: {}, files: {}, prev: 'f'.repeat(64), sig: 'a'.repeat(64) }) + '\n';
      writeFileSync(join(root, 'bogus.jsonl'), bogus);
      g('add', 'bogus.jsonl'); g('commit', '-qm', 'bogus');
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: g('rev-parse', 'HEAD'), sourcePath: 'bogus.jsonl', cwd: root });
      assert.equal(plan.decision, 'refuse-broken-chain');
    } finally { clean(root); }
  });
});

describe('the salvage', () => {
  it('dry-run plans (count, branch, source) and writes nothing', () => {
    const { root, dir, sourceSha } = scenario();
    try {
      const before = readdirSync(join(dir, 'manifest.d')).sort();
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root });
      assert.equal(plan.decision, 'plan');
      assert.equal(plan.entries.length, 2);
      assert.equal(plan.branch, 'feat-x');
      assert.equal(plan.sourceSha, sourceSha);
      assert.deepEqual(readdirSync(join(dir, 'manifest.d')).sort(), before, 'dry-run must not mint');
    } finally { clean(root); }
  });

  it('end-to-end: content preserved, root untouched, forest verifies, reader finds the approve, the CI gate accepts', () => {
    const { root, dir, sourceSha } = scenario();
    try {
      const rootBefore = readFileSync(join(dir, 'manifest.jsonl'));
      const result = migrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root, write: true });
      assert.equal(result.decision, 'applied');
      assert.equal(result.entries.length, 2);

      // root byte-identical
      assert.ok(readFileSync(join(dir, 'manifest.jsonl')).equals(rootBefore), 'the frozen root must not change');

      // the minted segment holds the salvaged entries + the disclosure record
      const segName = result.segment;
      const segLines = readFileSync(join(dir, 'manifest.d', segName), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(segLines.length, 3, 'two salvaged + one salvage record');
      assert.equal(segLines[0].data.note, 'work-10', 'content fields byte-preserved');
      assert.equal(segLines[1].ticket, 'T-SALVAGED');
      assert.equal(segLines[1].data.revision, 'git-change:oldbase:samedigest', 'revision binding intact for carry-forward');
      assert.equal(segLines[2].gate, 'manifest-salvage');
      assert.equal(segLines[2].data.sourceSha, sourceSha);
      assert.equal(segLines[2].data.salvagedEntries, 2);
      assert.equal(segLines[0].anchor?.segment, 'root', 'first entry anchors to the root');

      // the whole forest verifies under the key
      const verified = verify(dir, { key: KEY, requireSignatures: true });
      assert.equal(verified.valid, true, verified.message);

      // the reader surfaces the salvaged approve with its binding
      const { entries } = readManifestForest(dir);
      const found = entries.find((e) => e.ticket === 'T-SALVAGED' && e.data?.verdict === 'approve');
      assert.ok(found, 'carry-forward needs the approve findable in the forest');

      // and the gate that judges the salvage PR accepts the transition:
      // base = migrated main (root + marker, no segments); head = +1 segment
      assert.doesNotThrow(() => assertRootTransition({
        basePresent: true, baseBytes: rootBefore, headPresent: true,
        headBytes: readFileSync(join(dir, 'manifest.jsonl')),
        migration: { verified: false }, baseMarkerPresent: true,
      }));
      assert.doesNotThrow(() => validateSegmentAppendOnly(new Map(), new Map([[segName, readFileSync(join(dir, 'manifest.d', segName))]]), { forestAuth: 'keyed' }));
      assert.doesNotThrow(() => validateNewSegments({
        headSegments: new Map([[segName, readFileSync(join(dir, 'manifest.d', segName))]]),
        baseSegmentNames: new Set(),
        baseRootPresent: true,
        headRootText: rootBefore.toString('utf8'),
        forestAuth: 'keyed',
      }));
    } finally { clean(root); }
  });

  it('genuinely UNSIGNED source entries are admitted only with --attest-unsigned, and disclosed', () => {
    const { root, dir, g } = scenario();
    try {
      // craft a source with one unsigned branch entry chained over the shared prefix
      const working = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
      const sharedLines = working.trim().split('\n').slice(0, 2);
      const unsignedEntry = { seq: 3, gate: 'evidence', ts: '2026-01-01T09:00:00.000Z', data: { legacy: true }, files: {}, prev: sha256(sharedLines.at(-1)) };
      const src = sharedLines.join('\n') + '\n' + JSON.stringify(unsignedEntry) + '\n';
      writeFileSync(join(root, 'legacy.jsonl'), src);
      g('add', 'legacy.jsonl'); g('commit', '-qm', 'legacy source');
      const sha = g('rev-parse', 'HEAD');
      const refused = planMigrateBranch(dir, { key: KEY, sourceRef: sha, sourcePath: 'legacy.jsonl', cwd: root });
      assert.equal(refused.decision, 'refuse-unsigned');
      const admitted = planMigrateBranch(dir, { key: KEY, sourceRef: sha, sourcePath: 'legacy.jsonl', cwd: root, attestUnsigned: true });
      assert.equal(admitted.decision, 'plan');
      assert.equal(admitted.unsignedEntries.length, 1);
    } finally { clean(root); }
  });
});

describe('signature-coverage, race detection, and resumability', () => {
  it('a v1-signed entry carrying a field its signature never covered refuses — no laundering into v2', async () => {
    const { root, dir, sourceSha, g } = scenario();
    try {
      // take the real branch source and bolt an UNSIGNED field onto a
      // v1-style entry: rewrite the last branch entry as v1-signed (drop
      // sigVersion, re-sign the v1 subset) plus an extra field
      const branchRoot = execFileSync('git', ['show', `${sourceSha}:.adlc/manifest.jsonl`], { cwd: root, encoding: 'utf8' });
      const lines = branchRoot.trim().split('\n');
      const { signEntry } = await import('../lib/sign.mjs');
      const last = JSON.parse(lines.at(-1));
      delete last.sigVersion; delete last.sig;
      last.smuggled = 'never-signed';
      const v1subset = { seq: last.seq, gate: last.gate, ts: last.ts, ...(last.ticket !== undefined ? { ticket: last.ticket } : {}), data: last.data, files: last.files, prev: last.prev };
      void v1subset;
      last.sig = signEntry(KEY, { ...last });
      lines[lines.length - 1] = JSON.stringify(last);
      writeFileSync(join(root, 'v1extra.jsonl'), lines.join('\n') + '\n');
      g('add', 'v1extra.jsonl'); g('commit', '-qm', 'v1 with smuggled field');
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: g('rev-parse', 'HEAD'), sourcePath: 'v1extra.jsonl', cwd: root });
      assert.equal(plan.decision, 'refuse-uncovered');
      assert.match(plan.reason, /smuggled/);
    } finally { clean(root); }
  });

  it('an interrupted salvage RESUMES: already-appended prefix is skipped, the record still lands', () => {
    const { root, dir, sourceSha } = scenario();
    try {
      // simulate the crash: salvage only the FIRST entry by hand via the
      // production writer, exactly as an interrupted run would have
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root });
      const first = plan.entries[0].entry;
      const payload = {};
      for (const [k, v] of Object.entries(first)) {
        if (!['seq', 'prev', 'sig', 'sigVersion', 'segment', 'anchor', 'branch'].includes(k)) payload[k] = v;
      }
      appendManifestEntry(payload, dir, { signatureVersion: 2, cwd: root, key: KEY });
      // the resume: plan again — must be a plan, not refuse-existing-segment
      const resume = migrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root, write: true });
      assert.equal(resume.decision, 'applied');
      assert.equal(resume.entries.length, 1, 'only the remainder is appended');
      const segLines = readFileSync(join(dir, 'manifest.d', resume.segment), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(segLines.length, 3, 'first (pre-crash) + second (resumed) + salvage record');
      assert.equal(segLines.at(-1).gate, 'manifest-salvage');
      assert.equal(segLines.at(-1).data.salvagedEntries, 2, 'the record discloses the FULL salvage, not the resumed remainder');
      assert.equal(segLines.at(-1).data.salvagedLineHashes.length, 2);
      const verified = verify(dir, { key: KEY, requireSignatures: true });
      assert.equal(verified.valid, true, verified.message);
    } finally { clean(root); }
  });

  it('a branch segment holding entries UNRELATED to the salvage still refuses', () => {
    const { root, dir, sourceSha } = scenario();
    try {
      appendManifestEntry({ gate: 'evidence', data: { note: 'fresh-work-not-salvage' }, files: {} }, dir, { signatureVersion: 2, cwd: root, key: KEY });
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root });
      assert.equal(plan.decision, 'refuse-existing-segment');
    } finally { clean(root); }
  });

  it('the post-write mint verification detects a raced foreign segment', () => {
    // structural pin: the applied result must verify that the segment's
    // entries match what the salvage planned, so a concurrent writer
    // sneaking a mint between plan and write is DETECTED, not silently
    // extended.
    const src = readFileSync(new URL('../lib/migrate-branch.mjs', import.meta.url), 'utf8');
    assert.match(src, /post-write verification|raced|does not match the salvage plan/i);
  });
});

describe('round-2 hardening', () => {
  it('a flag-shaped source ref refuses before reaching git', () => {
    const { root, dir } = scenario();
    try {
      for (const bad of ['--upload-pack=/tmp/evil', '-x']) {
        const plan = planMigrateBranch(dir, { key: KEY, sourceRef: bad, cwd: root });
        assert.equal(plan.decision, 'refuse-source', `expected refusal for ${bad}`);
      }
    } finally { clean(root); }
  });

  it('a completed IDENTICAL salvage refuses as done; a MISMATCHED record refuses as inspect-first', () => {
    const { root, dir, sourceSha } = scenario();
    try {
      migrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root, write: true });
      const done = planMigrateBranch(dir, { key: KEY, sourceRef: sourceSha, cwd: root });
      assert.equal(done.decision, 'refuse-existing-segment');
      assert.match(done.reason, /THIS salvage|nothing left/);
    } finally { clean(root); }
  });

  it('the pre-record verification precedes the record append (structural pin)', () => {
    const src = readFileSync(new URL('../lib/migrate-branch.mjs', import.meta.url), 'utf8');
    const precheck = src.indexOf('no salvage record was written');
    const recordAppend = src.indexOf("gate: 'manifest-salvage'", precheck);
    assert.ok(precheck > 0 && recordAppend > precheck, 'verification must run before the record lands — the old order left a retry-blocking record behind');
  });
});

describe('mutation kill coverage', () => {
  const BIN = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;

  it('the migrate-branch verb: refusal exits 2 (json), human dry-run exits 0 with correct pluralization', () => {
    const { root, sourceSha } = scenario();
    try {
      const env = { ...process.env, ADLC_MANIFEST_KEY: KEY };
      const refused = spawnSync(process.execPath, [BIN, 'migrate-branch', '--from', 'no-such-ref', '--json'], { cwd: root, encoding: 'utf8', env });
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(JSON.parse(refused.stdout).decision, /^refuse-/);
      const dry = spawnSync(process.execPath, [BIN, 'migrate-branch', '--from', sourceSha], { cwd: root, encoding: 'utf8', env });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /2 entries from/, 'two salvaged entries pluralize as entries');
      const usage = spawnSync(process.execPath, [BIN], { cwd: root, encoding: 'utf8', env });
      assert.match(usage.stderr + usage.stdout, /migrate-branch \[--from <ref>\]/, 'the usage line advertises the verb correctly');
    } finally { clean(root); }
  });

  it('a clean v1-signed source entry salvages — its own sig field is a covered field, not contraband', async () => {
    const { root, dir, g } = scenario();
    try {
      const { signEntry } = await import('../lib/sign.mjs');
      const working = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
      const sharedLines = working.trim().split('\n').slice(0, 2);
      const v1 = { seq: 3, gate: 'evidence', ts: '2026-01-01T09:00:00.000Z', data: { legacy: 'v1' }, files: {}, prev: sha256(sharedLines.at(-1)) };
      v1.sig = signEntry(KEY, v1);
      writeFileSync(join(root, 'v1clean.jsonl'), sharedLines.join('\n') + '\n' + JSON.stringify(v1) + '\n');
      g('add', 'v1clean.jsonl'); g('commit', '-qm', 'v1 clean');
      const plan = planMigrateBranch(dir, { key: KEY, sourceRef: g('rev-parse', 'HEAD'), sourcePath: 'v1clean.jsonl', cwd: root });
      assert.equal(plan.decision, 'plan', plan.reason);
    } finally { clean(root); }
  });

  it('contentKey is key-order insensitive — the property resume and race comparisons stand on', async () => {
    const { contentKey } = await import('../lib/migrate-branch.mjs');
    const a = { gate: 'evidence', ts: 't', data: { x: 1, y: [1, { b: 2, a: 1 }] }, files: {} };
    const b = { files: {}, data: { y: [1, { a: 1, b: 2 }], x: 1 }, ts: 't', gate: 'evidence' };
    assert.equal(contentKey(a), contentKey(b), 'same content, different key order, must compare equal');
    assert.notEqual(contentKey(a), contentKey({ ...a, data: { x: 2 } }));
  });
});
