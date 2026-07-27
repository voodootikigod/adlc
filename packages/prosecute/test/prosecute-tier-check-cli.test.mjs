// Concern: bin/adlc-prosecute.mjs `tier-check` subcommand (#326) — the CI trust-root
// cross-model gate, end-to-end at the process boundary in a real git repo.
//
// Properties pinned:
//   - a non-trust-root change exits 0 and says so (AC3 visibility);
//   - a trust-root change with NO attestation exits 2 (AC1);
//   - the same change exits 0 once a distinct-provider approve bound to the
//     tier-check revision is recorded;
//   - the add-vs-alter calibration (#326): an ADDITIVE ticket write does NOT tier,
//     while ALTERING an existing ticket contract DOES;
//   - a tiered change with no --author-provider fails closed (exit 1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

// #326 hardening: the gate verifies attestation signatures, so both record-cross-model (which
// signs) and tier-check (which verifies) need ADLC_MANIFEST_KEY. Set it for the whole file so
// runBin subprocesses inherit it; the no-key fail-closed case overrides it to '' per-call.
process.env.ADLC_MANIFEST_KEY = 'test-tier-check-signing-key';

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

// Scratch repo: base `.adlc/tickets.json` = baseTickets, committed on main; then on
// a feat branch apply mutate(dir) and commit. Rails default to src/** so the ticket
// store file itself is not a rails-deny-path match — the ticket-store surface is
// exercised purely through the add-vs-alter calibration.
function scratchRepo({ baseTickets, mutate }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-tier-check-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: baseTickets }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 0;\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  mutate(dir, g);
  g('add', '-A'); g('commit', '-qm', 'change');
  return { dir, g };
}

const T = (over = {}) => ({ id: 'T1', title: 'x', scope: ['src/**'], rails: ['src/**'], edges: [], ...over });
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

describe('adlc-prosecute tier-check (#326 CI trust-root gate)', () => {
  it('exits 0 and reports NOT trust-root tier for an ordinary change', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => writeFileSync(join(d, 'src', 'ordinary.mjs'), 'export const y = 1;\n') });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /NOT trust-root tier/);

      // --json contract: a non-tier change reports satisfied:true, crossModelRequired:false.
      const j = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir);
      assert.equal(j.status, 0);
      assert.deepEqual(JSON.parse(j.stdout), { trustRootTier: false, reasons: [], crossModelRequired: false, satisfied: true });
    } finally { cleanup(dir); }
  });

  it('exits 2 for a trust-root change (enforcement package) with no attestation', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => {
      mkdirSync(join(d, 'packages', 'prosecute', 'lib'), { recursive: true });
      writeFileSync(join(d, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const z = 1;\n');
    } });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /TRUST-ROOT tier/);
      assert.match(r.stderr, /NO SIGNATURE-VERIFIED cross-model attestation/);
      // The failure must show the actionable, signable record command verbatim — a
      // maintainer copies it. Pin the template so a garbled hint cannot ship silently.
      assert.match(r.stderr, /adlc-prosecute record-cross-model --ticket <id>/);
    } finally { cleanup(dir); }
  });

  it('#326 forge resistance: an UNSIGNED attestation does NOT satisfy the gate', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => {
      mkdirSync(join(d, 'packages', 'prosecute', 'lib'), { recursive: true });
      writeFileSync(join(d, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const z = 1;\n');
    } });
    try {
      const rev = JSON.parse(runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir).stdout).revision;
      // Attacker records the approve WITHOUT the key (unsigned) — the forge.
      runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', rev, '--dir', '.adlc'], dir, { ADLC_MANIFEST_KEY: '' });
      // Gate (with the key) rejects the unsigned entry — still fails closed.
      const after = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(after.status, 2, 'an unsigned forged approve must not satisfy the gate');
    } finally { cleanup(dir); }
  });

  it('#326: fails closed with a distinct message when ADLC_MANIFEST_KEY is unavailable', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => {
      mkdirSync(join(d, 'packages', 'prosecute', 'lib'), { recursive: true });
      writeFileSync(join(d, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const z = 1;\n');
    } });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir, { ADLC_MANIFEST_KEY: '' });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /ADLC_MANIFEST_KEY is not available/);
      // --json contract on the no-key path: still a trust-root tier and STILL failing
      // closed, but distinguishably because the key is absent (keyAvailable:false), so a
      // consumer does not misread it as "attestation simply missing".
      const j = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir, { ADLC_MANIFEST_KEY: '' });
      assert.equal(j.status, 2);
      const jj = JSON.parse(j.stdout);
      assert.equal(jj.trustRootTier, true);
      assert.equal(jj.crossModelRequired, true);
      assert.equal(jj.satisfied, false);
      assert.equal(jj.keyAvailable, false);
    } finally { cleanup(dir); }
  });

  it('exits 0 once a distinct-provider approve bound to the tier-check revision is recorded', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => {
      mkdirSync(join(d, 'packages', 'prosecute', 'lib'), { recursive: true });
      writeFileSync(join(d, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const z = 1;\n');
    } });
    try {
      const before = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir);
      assert.equal(before.status, 2);
      const beforeJson = JSON.parse(before.stdout);
      const { revision } = beforeJson;
      assert.ok(revision, 'tier-check surfaces the revision');
      // --json contract for a tiered-but-unattested change: the fields must reflect
      // trust-root tier and an unmet requirement, not just the exit code.
      assert.equal(beforeJson.trustRootTier, true);
      assert.equal(beforeJson.crossModelRequired, true);
      assert.equal(beforeJson.satisfied, false);

      const rec = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', revision, '--dir', '.adlc'], dir);
      assert.equal(rec.status, 0);

      const after = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(after.status, 0);
      assert.match(after.stdout, /cross-model approve found/);
    } finally { cleanup(dir); }
  });

  it('a ticket-store change (additive OR altering) does NOT tier — rails-guard-ci owns the store (#326)', () => {
    // Adding a ticket, and even altering an existing ticket's rails, both exit 0
    // here: the cross-model tier deliberately does not cover the ticket store
    // (rails-guard-ci already enforces its add-vs-alter contract).
    const additive = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T({ rails: [] }), { id: 'T2', title: 'new', scope: ['src/**'], rails: [], edges: [] }] })),
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], additive.dir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /NOT trust-root tier/);
    } finally { cleanup(additive.dir); }

    const altering = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T({ rails: [], title: 'renamed' })] })),
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], altering.dir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /NOT trust-root tier/);
    } finally { cleanup(altering.dir); }
  });

  it('classifies an UNTRACKED trust-root file when a non-trust-root path sorts ahead of it (guards the -z NUL-split of the untracked walk)', () => {
    // The untracked-file walk uses `git ls-files --others -z` + split('\0'). Drop
    // the -z and git emits NEWLINE-separated paths, so split('\0') collapses ALL
    // untracked files into ONE joined string. Its prefix is whatever sorts FIRST,
    // so a trust-root file that sorts after a benign one is no longer prefix-matched
    // → the change silently fails to tier (a fail-OPEN). This fixture makes the
    // benign root file (`a-untracked.md`) sort before the enforcement-package file
    // and leaves BOTH untracked; the tracked diff is only a benign src change, so
    // the untracked prosecute file is the SOLE trust-root trigger. With -z it tiers
    // (exit 2); without -z it would exit 0 — which is what the mutation gate caught.
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => writeFileSync(join(d, 'src', 'ordinary.mjs'), 'export const y = 1;\n') });
    try {
      writeFileSync(join(dir, 'a-untracked.md'), 'benign, sorts first\n');
      mkdirSync(join(dir, 'packages', 'prosecute', 'lib'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'prosecute', 'lib', 'untracked.mjs'), 'export const z = 1;\n');
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /TRUST-ROOT tier/);
      assert.match(r.stderr, /packages\/prosecute\//);
    } finally { cleanup(dir); }
  });

  it('fails closed (exit 1) with actionable guidance when the --base ref is unresolvable', () => {
    // An unresolvable base means the changed-file set cannot be computed, so the gate
    // must FAIL rather than silently treat the change as empty/non-tier. The error
    // names the fix (fetch the ref / pass --base <ref>) so CI is not a dead end.
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => writeFileSync(join(d, 'src', 'ordinary.mjs'), 'export const y = 1;\n') });
    try {
      const r = runBin(['tier-check', '--base', 'no-such-ref-xyz', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /cannot determine the changed-file set/);
      assert.match(r.stderr, /--base <ref>/);
    } finally { cleanup(dir); }
  });

  it('fails closed (exit 1) on a tiered change with no --author-provider', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: (d) => {
      mkdirSync(join(d, 'packages', 'gate-manifest', 'lib'), { recursive: true });
      writeFileSync(join(d, 'packages', 'gate-manifest', 'lib', 'x.mjs'), 'export const z = 1;\n');
    } });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--dir', '.adlc'], dir, { ADLC_AUTHOR_PROVIDER: '' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /no --author-provider/);
    } finally { cleanup(dir); }
  });
});
