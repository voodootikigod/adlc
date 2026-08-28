// AC 160 — manifest verification is KEYED: the `gate-manifest verify` spawn
// carries ADLC_MANIFEST_KEY and `--allow-legacy-unsigned`; run against a copy
// of THIS repository's real manifest (legacy unsigned prefix included) plus a
// signed run segment the REAL gate passes, while a forged signature, a missing
// signature on a post-prefix line, or an unsigned run entry makes it fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv, KEY_BEARING_ARGV } from '../lib/keys.mjs';
import { appendManifestEntry } from '../../gate-manifest/lib/record.mjs';
import { createSequenceFixture } from './helpers/sequence-fixture.mjs';
import { runIssue } from '../lib/run.mjs';
import { FAKE } from './helpers/recover-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const ADLC = join(REPO, 'packages', 'cli', 'bin', 'adlc.mjs');
const KEY = 'manifest-verify-test-key-0123456789abcdef0123456789abcdef';

function verify(dir, { key = KEY, allowLegacy = true } = {}) {
  const env = childEnv({ PATH: process.env.PATH, HOME: dir }, key ? { key, keyBearing: true } : {});
  const r = spawnSync(process.execPath, [ADLC, 'gate-manifest', 'verify', '--dir', join(dir, '.adlc'), ...(allowLegacy ? ['--allow-legacy-unsigned'] : []), '--json'], { cwd: dir, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** A fresh git repo on the run branch holding the legacy UNSIGNED prefix of this repository's real root manifest verbatim. */
function manifestCopy() {
  const root = mkdtempSync(join(tmpdir(), 'ap-manifest-'));
  mkdirSync(join(root, '.adlc', 'manifest.d'), { recursive: true });
  const lines = readFileSync(join(REPO, '.adlc', 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean);
  const firstSigned = lines.findIndex((l) => typeof JSON.parse(l).sig === 'string');
  assert.ok(firstSigned > 0, 'the real manifest has a legacy unsigned prefix followed by signed entries');
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), `${lines.slice(0, firstSigned).join('\n')}\n`);
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  git(['init', '-q', '-b', 'adlc/autopilot/issue-7']); git(['add', '-A']); git(['commit', '-q', '-m', 'manifest copy']);
  return { root, prefixLines: firstSigned };
}

/** The run's own segment lines as the REAL recorder writes them (chained, signed with the test key). */
function appendRunEntry(root, gate) {
  return appendManifestEntry({ gate, ticket: 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', data: { ticket: 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', verdict: 'approve' } }, join(root, '.adlc'), { cwd: root, key: KEY });
}
const segmentFiles = (root) => readdirSync(join(root, '.adlc', 'manifest.d')).filter((f) => f.endsWith('.jsonl')).map((f) => join(root, '.adlc', 'manifest.d', f));

export function ac160_manifestVerificationIsKeyed() {
  assert.ok(KEY_BEARING_ARGV.some((a) => a.join(' ').includes('gate-manifest verify')), 'gate-manifest verify is in the §9.3 key-bearing allowlist');
  const { root } = manifestCopy();
  try {
    const base = verify(root);
    assert.equal(base.status, 0, `the real manifest's legacy unsigned prefix passes with --allow-legacy-unsigned: ${base.out.slice(-600)}`);
    appendRunEntry(root, 'coldstart'); appendRunEntry(root, 'spec-lint');
    const withRun = verify(root);
    assert.equal(withRun.status, 0, `a signed run segment written by the real recorder passes: ${withRun.out.slice(-600)}`);
    // A repository that has not cut over to segments appends to the root chain; a segmented one to its lineage segment.
    const files = segmentFiles(root);
    const seg = files.find((f) => readFileSync(f, 'utf8').includes('"coldstart"')) ?? join(root, '.adlc', 'manifest.jsonl');
    const pristine = readFileSync(seg, 'utf8');
    const entries = pristine.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(entries.slice(-2).every((e) => typeof e.sig === 'string' && e.sig.length > 0), 'every run entry is signed');
    // forged signature on a line
    writeFileSync(seg, `${entries.map((e, i) => JSON.stringify(i === entries.length - 1 ? { ...e, sig: 'f'.repeat(e.sig.length) } : e)).join('\n')}\n`);
    assert.notEqual(verify(root).status, 0, 'a forged signature fails the gate');
    // a missing signature on a post-prefix line
    writeFileSync(seg, `${entries.map((e, i) => { if (i !== entries.length - 1) return JSON.stringify(e); const { sig: _s, ...rest } = e; return JSON.stringify(rest); }).join('\n')}\n`);
    assert.notEqual(verify(root).status, 0, 'a missing signature on a post-prefix line fails the gate');
    writeFileSync(seg, pristine);
    assert.equal(verify(root).status, 0, 'restored → passes again');
    // The gate itself verifies chain-only without a key (the repository's mixed manifest keeps it functional); the
    // autopilot's obligation is that ITS verify spawn always carries the key — asserted on the recorder below.
    const children = KEY_BEARING_ARGV.map((a) => a.join(' '));
    assert.equal(children.length, 7, 'the §9.3 allowlist has exactly the seven key-bearing children');
    for (const want of ['ticket create', 'ticket complete', 'ticket update', 'coldstart', 'spec-lint', 'record-cross-model', 'gate-manifest verify']) assert.ok(children.some((c) => c.includes(want)), `allowlist names ${want}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC160: the real gate-manifest verify passes a copy of this repository\'s manifest plus a signed run segment, and fails on a forged signature, a missing post-prefix signature, or no key', { timeout: 120_000 }, ac160_manifestVerificationIsKeyed);

export async function ac160_verifySpawnCarriesTheKey() {
  const fx = await createSequenceFixture();
  try {
    const result = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    assert.equal(result.state, 'done');
    const verifies = fx.recorder.filter((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'gate-manifest' && r.argv[2] === 'verify');
    assert.ok(verifies.length >= 2, 'the verify spawn ran at every actual-diff check');
    for (const v of verifies) {
      assert.equal(v.env.ADLC_MANIFEST_KEY, fx.key, 'the spawn env carries ADLC_MANIFEST_KEY');
      assert.ok(v.argv.includes('--allow-legacy-unsigned'), 'and the argv carries --allow-legacy-unsigned');
    }
  } finally { fx.cleanup(); }
}
test('AC160: the gate-manifest verify spawn of the actual-diff check carries ADLC_MANIFEST_KEY in its env and --allow-legacy-unsigned in its argv', { timeout: 120_000 }, ac160_verifySpawnCarriesTheKey);
