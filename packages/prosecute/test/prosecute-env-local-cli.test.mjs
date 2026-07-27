// Concern: the bin wires loadManifestKeyFromEnvLocal() so record-cross-model / tier-check pick
// up ADLC_MANIFEST_KEY from ./.env.local locally — but NEVER under CI, where cwd is the
// PR-controlled tree. Proven at the process boundary in a real git repo.
//
// Hermetic env: we build the subprocess environment explicitly (deleting any ambient
// ADLC_MANIFEST_KEY / CI vars) so the result does not depend on the developer's or CI runner's
// exported key — the whole point under test is where the key comes FROM.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
const KEY = 'env-local-signing-key';

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GITHUB_ACTIONS;
  delete env.CI;
  return { ...env, ...overrides };
}

function runBin(args, cwd, env) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// A scratch repo whose feature branch makes a trust-root change (an enforcement-package file),
// plus a .env.local holding the signing key at the repo root.
function scratchRepo(envLocalContents) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-envlocal-cli-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co'); g('config', 'user.name', 'tester'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }] }));
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  mkdirSync(join(dir, 'packages', 'prosecute', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const z = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'trust-root change');
  if (envLocalContents !== null) writeFileSync(join(dir, '.env.local'), envLocalContents);
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const TIER = ['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'];
const REC = (rev) => ['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', rev, '--dir', '.adlc'];

describe('.env.local key loading — SIGNING (record) reads it, VERIFYING (tier-check) never does', () => {
  it('record-cross-model signs via .env.local; the attestation then verifies with an EXPORTED key', () => {
    const dir = scratchRepo(`ADLC_MANIFEST_KEY=${KEY}\n`);
    try {
      const rev = JSON.parse(runBin([...TIER, '--json'], dir, cleanEnv()).stdout).revision;
      assert.ok(rev, 'revision resolved');
      // record loads the key from .env.local (no exported key, not CI) and SIGNS.
      const rec = runBin(REC(rev), dir, cleanEnv());
      assert.equal(rec.status, 0, rec.stderr);
      // Verifying with the key EXPORTED passes — proving record signed with the .env.local key.
      const withKey = runBin(TIER, dir, cleanEnv({ ADLC_MANIFEST_KEY: KEY }));
      assert.equal(withKey.status, 0, withKey.stderr);
      assert.match(withKey.stdout, /cross-model approve found/);
    } finally { cleanup(dir); }
  });

  it('tier-check NEVER reads the key from .env.local — a force-added key + forged approve still fails closed (#354 loader F2)', () => {
    // The attack the loader must not enable: a contributor force-adds .env.local with THEIR key and
    // records a matching approve signed by it; a maintainer then runs tier-check locally with no
    // exported key and not in CI. tier-check must NOT source its verification key from the tree.
    const dir = scratchRepo('ADLC_MANIFEST_KEY=attacker-key\n');
    try {
      const rev = JSON.parse(runBin([...TIER, '--json'], dir, cleanEnv()).stdout).revision;
      // record DOES load the attacker key from .env.local and signs a matching approve…
      assert.equal(runBin(REC(rev), dir, cleanEnv()).status, 0);
      // …but tier-check must not, so it fails closed rather than trusting a tree-supplied key.
      const r = runBin(TIER, dir, cleanEnv());
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /ADLC_MANIFEST_KEY is not available/);
    } finally { cleanup(dir); }
  });

  it('tier-check under CI also ignores .env.local (defense in depth)', () => {
    const dir = scratchRepo(`ADLC_MANIFEST_KEY=${KEY}\n`);
    try {
      const rev = JSON.parse(runBin([...TIER, '--json'], dir, cleanEnv()).stdout).revision;
      runBin(REC(rev), dir, cleanEnv());
      const ci = runBin(TIER, dir, cleanEnv({ GITHUB_ACTIONS: 'true' }));
      assert.equal(ci.status, 2, ci.stdout + ci.stderr);
      assert.match(ci.stderr, /ADLC_MANIFEST_KEY is not available/);
    } finally { cleanup(dir); }
  });

  it('record-cross-model: an EXPORTED key wins over .env.local (non-override)', () => {
    const dir = scratchRepo('ADLC_MANIFEST_KEY=file-key-should-lose\n');
    try {
      const exported = cleanEnv({ ADLC_MANIFEST_KEY: 'exported-key-wins' });
      const rev = JSON.parse(runBin([...TIER, '--json'], dir, exported).stdout).revision;
      runBin(REC(rev), dir, exported); // record signs with the exported key, NOT the file key
      // Verify with the exported key → passes; with the file key → fails. Proves the export signed.
      assert.equal(runBin(TIER, dir, cleanEnv({ ADLC_MANIFEST_KEY: 'exported-key-wins' })).status, 0);
      assert.equal(runBin(TIER, dir, cleanEnv({ ADLC_MANIFEST_KEY: 'file-key-should-lose' })).status, 2);
    } finally { cleanup(dir); }
  });
});
