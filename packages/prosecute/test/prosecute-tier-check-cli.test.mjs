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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
      // --allow-unsigned is required since #370: recording now fails closed with no key.
      // Writing unsigned is the whole point HERE, so the opt-in is the deliberate act it
      // was added for — an attacker has it too, which is why the gate must still reject.
      const forge = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', rev, '--dir', '.adlc', '--allow-unsigned'], dir, { ADLC_MANIFEST_KEY: '' });
      assert.equal(forge.status, 0, 'the forged entry must actually be written, or this proves nothing');
      // PRECONDITION, not decoration: without it, a record path that silently wrote
      // NOTHING would leave the gate failing for want of any attestation at all, and
      // this test would still pass while no longer exercising forge resistance.
      const forged = JSON.parse(readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8').trim().split('\n').at(-1));
      assert.equal(forged.gate, 'cross-model-review');
      assert.equal(forged.data.verdict, 'approve');
      assert.equal(forged.data.revision, rev, 'the forge is bound to the revision the gate checks');
      assert.equal(forged.sig, undefined, 'and it is unsigned — the property under test');
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

// ── #364: a BROKEN CHAIN is not a MISSING ATTESTATION ────────────────────────
// hasCrossModelApproveForRevision checks manifestChainTrustworthy BEFORE it looks at
// any entry, so one present-but-invalid signature anywhere fails every trust-root PR
// regardless of its own attestation. The wrong key produces exactly that: verify.mjs
// rejects a present-but-invalid sig in BOTH modes ("or the wrong key signed it").
//
// Emitting the generic "NO SIGNATURE-VERIFIED attestation" there tells the operator to
// record one — which cannot help, because the chain check fails before the new entry is
// ever examined. The cost is a full adversarial review spent on a dead end. These pin
// the two causes as distinguishable, in the same spirit as the existing no-key branch.
describe('adlc-prosecute tier-check — chain failure vs missing attestation (#364)', () => {
  const tierChange = (d) => {
    mkdirSync(join(d, 'packages', 'prosecute', 'lib'), { recursive: true });
    writeFileSync(join(d, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const z = 1;\n');
  };
  const KEY_A = 'key-before-rotation';
  const KEY_B = 'key-after-rotation';

  // Record a valid signed approve with KEY_A, then verify under KEY_B — precisely what a
  // key rotation does to already-signed history.
  function repoWithRotatedKey() {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: tierChange });
    const rev = JSON.parse(runBin(
      ['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'],
      dir, { ADLC_MANIFEST_KEY: KEY_A }
    ).stdout).revision;
    const rec = runBin(
      ['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic',
       '--verdict', 'approve', '--revision', rev, '--dir', '.adlc'],
      dir, { ADLC_MANIFEST_KEY: KEY_A }
    );
    assert.equal(rec.status, 0, 'precondition: the approve records cleanly under the original key');
    const ok = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir, { ADLC_MANIFEST_KEY: KEY_A });
    assert.equal(ok.status, 0, 'precondition: the gate passes before rotation');
    return { dir, rev };
  }

  it('names chain-verification failure (not a missing attestation) after a key rotation', () => {
    const { dir } = repoWithRotatedKey();
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir, { ADLC_MANIFEST_KEY: KEY_B });
      assert.equal(r.status, 2, 'a manifest that does not verify must still fail closed');
      assert.match(r.stderr, /chain/i, 'must name chain verification as the cause');
      assert.match(r.stderr, /rotat/i, 'must name key rotation as a likely cause');
      assert.match(r.stderr, /will not|cannot|does not clear/i,
        'must say recording a new attestation will not clear this');
    } finally { cleanup(dir); }
  });

  it('does NOT print the record-cross-model hint when the chain itself is broken', () => {
    const { dir } = repoWithRotatedKey();
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir, { ADLC_MANIFEST_KEY: KEY_B });
      assert.doesNotMatch(r.stderr, /NO SIGNATURE-VERIFIED cross-model attestation/,
        'the missing-attestation message must not appear when the cause is a broken chain');
    } finally { cleanup(dir); }
  });

  it('the genuine missing-attestation case keeps its existing message and hint', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: tierChange });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir, { ADLC_MANIFEST_KEY: KEY_A });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /NO SIGNATURE-VERIFIED cross-model attestation/);
      assert.match(r.stderr, /adlc-prosecute record-cross-model --ticket <id>/);
      assert.doesNotMatch(r.stderr, /rotat/i,
        'a genuinely absent attestation must not be blamed on key rotation');
    } finally { cleanup(dir); }
  });

  // The asymmetry that IS the bug, pinned from both sides. record-cross-model already
  // refuses to append onto an unverifiable chain and names the true cause exactly. So the
  // operator is not stuck in a loop — but they only learn this AFTER tier-check has sent
  // them to spend a full adversarial review. tier-check is the surface that misattributes;
  // this test pins record's good behavior as the standard tier-check must meet.
  it('record-cross-model already names the true cause — tier-check is the surface that misattributes', () => {
    const { dir, rev } = repoWithRotatedKey();
    try {
      const rec = runBin(
        ['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic',
         '--verdict', 'approve', '--revision', rev, '--dir', '.adlc'],
        dir, { ADLC_MANIFEST_KEY: KEY_B }
      );
      assert.equal(rec.status, 1, 'appending onto an unverifiable chain must fail closed');
      assert.match(rec.stderr, /chain is invalid|chain broken/i,
        'record already diagnoses the chain accurately — tier-check must not be less honest');
    } finally { cleanup(dir); }
  });

  it('--json distinguishes the chain failure from a missing attestation', () => {
    const { dir } = repoWithRotatedKey();
    try {
      const j = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--json'], dir, { ADLC_MANIFEST_KEY: KEY_B });
      assert.equal(j.status, 2);
      const jj = JSON.parse(j.stdout);
      assert.equal(jj.satisfied, false);
      assert.equal(jj.chainTrustworthy, false, 'consumers must be able to tell the causes apart');
    } finally { cleanup(dir); }
  });

  // AC5 — the constraint has to live where a maintainer doing routine secret hygiene will
  // meet it. The gate-manifest doc previously declared key rotation "out of scope for this
  // tool", which is precisely how a repo-breaking constraint went unrecorded; a doc that
  // silently loses this again should fail the build, not just read differently.
  it('documents that rotating the signing key is a migration, in both the tool doc and the ADR', () => {
    const root = new URL('../../../', import.meta.url).pathname;
    for (const rel of ['docs/tools/gate-manifest.md', 'docs/adr/0007-multimodel-adversarial-review.md']) {
      const text = readFileSync(join(root, rel), 'utf8');
      assert.match(text, /rotat/i, `${rel} must discuss key rotation`);
      assert.match(text, /migration/i, `${rel} must say rotation is a migration, not a secret update`);
      assert.match(text, /present-but-invalid|present but invalid/i,
        `${rel} must explain that old entries become present-but-invalid, not merely unsigned`);
    }
    // The sentence that caused the gap must not come back.
    const toolDoc = readFileSync(join(root, 'docs/tools/gate-manifest.md'), 'utf8');
    assert.doesNotMatch(toolDoc, /rotation[^.]*\bout of scope\b/i,
      'the tool doc must no longer declare key rotation out of scope');
  });

  // Non-weakening guard: the strictness must be untouched. If someone "fixes" this by
  // tolerating an invalid signature so the friendlier message becomes reachable, this fails.
  it('does not weaken verification: an invalid signature still fails the gate closed', () => {
    const { dir } = repoWithRotatedKey();
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir, { ADLC_MANIFEST_KEY: KEY_B });
      assert.equal(r.status, 2, 'a wrongly-signed entry must never be tolerated');
    } finally { cleanup(dir); }
  });
});
