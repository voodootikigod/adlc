import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ADMIN_PUB_FILENAME,
  generateEd25519KeyPair,
  signEntry,
} from '@adlc/gate-manifest/lib/sign.mjs';
import { sha256 } from '@adlc/core';
import {
  readObservedAttestations,
  mirrorObservedAttestations,
  assertNoTruncation,
} from '../lib/attestation-store.mjs';
import {
  recordCrossModelReview,
  carryForwardCrossModelReview,
  hasCrossModelApprove,
  hasCrossModelApproveForRevision,
} from '../lib/cross-model.mjs';
import { runProsecution, resolveProsecutionRevision } from '../lib/run.mjs';
import { loadManifestKeyFromEnvLocal, PRIVATE_KEY_ENV, MANIFEST_KEY } from '../lib/load-env-local.mjs';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runBin(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ADLC_MANIFEST_KEY: '', ADLC_MANIFEST_PRIVATE_KEY: '', ...env },
  });
}

function makeGitRepo(t, prefix = 'adlc-prosecute-ed25519-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'prosecute', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'prosecute', 'lib', 'sample.mjs'), 'export const v = 1;\n');
  writeFileSync(
    join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-ED1',
          title: 'Trust-root Ed25519 test ticket',
          completed: false,
          scope: ['packages/prosecute/**'],
          rails: [],
        },
      ],
    }, null, 2),
  );
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

describe('loadManifestKeyFromEnvLocal — ADLC_MANIFEST_PRIVATE_KEY precedence and fail-closed', () => {
  it('loads ADLC_MANIFEST_PRIVATE_KEY preferentially over ADLC_MANIFEST_KEY when unset', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-envlocal-ed25519-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { privateKey } = generateEd25519KeyPair();
    writeFileSync(join(dir, '.env.local'), `ADLC_MANIFEST_KEY=legacy-hmac\nADLC_MANIFEST_PRIVATE_KEY=${privateKey}\n`);

    const env = {};
    assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env, isCI: false }), true);
    assert.equal(env[PRIVATE_KEY_ENV], privateKey);
    assert.equal(env[MANIFEST_KEY], undefined);
  });

  it('respects explicit empty ADLC_MANIFEST_PRIVATE_KEY="" fail-closed and never loads in CI', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-envlocal-ed25519-empty-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { privateKey } = generateEd25519KeyPair();
    writeFileSync(join(dir, '.env.local'), `ADLC_MANIFEST_KEY=legacy-hmac\nADLC_MANIFEST_PRIVATE_KEY=${privateKey}\n`);

    const emptyPriv = { ADLC_MANIFEST_PRIVATE_KEY: '' };
    assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env: emptyPriv, isCI: false }), false);
    assert.equal(emptyPriv[PRIVATE_KEY_ENV], '');
    assert.equal(emptyPriv[MANIFEST_KEY], undefined);

    const ciEnv = {};
    assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env: ciEnv, isCI: true }), false);
    assert.equal(ciEnv[PRIVATE_KEY_ENV], undefined);
  });
});

describe('attestation-store — Ed25519 zero-secret verification and fail-closed checks', () => {
  it('mirrors, reads, and detects truncation of Ed25519 attestations with key: null and publicKey', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-store-ed25519-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const adlcDir = join(dir, 'pr', '.adlc');
    const storePath = join(dir, 'external-store', 'attestations.jsonl');
    mkdirSync(adlcDir, { recursive: true });
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const { publicKey: wrongPub } = generateEd25519KeyPair();
    writeFileSync(join(adlcDir, ADMIN_PUB_FILENAME), publicKey);

    const rev = 'git-change:aaa111:bbb222';
    const approve = recordCrossModelReview({
      ticket: 'T-ED1',
      revision: rev,
      provider: 'agy:Gemini 2.5 Pro',
      authorProvider: 'anthropic',
      verdict: 'approve',
      dir: adlcDir,
      key: privateKey,
    });
    const revoke = recordCrossModelReview({
      ticket: 'T-ED1',
      revision: rev,
      provider: 'agy:Gemini 2.5 Pro',
      authorProvider: 'anthropic',
      verdict: 'needs-attention',
      dir: adlcDir,
      key: privateKey,
    });

    // Returns [] ONLY when neither key nor publicKey is provided.
    assert.deepEqual(readObservedAttestations(storePath, { key: null, publicKey: null }), []);

    // Mirror with zero secret (key: null, publicKey).
    const count = mirrorObservedAttestations({
      prEntries: [approve, revoke],
      storePath,
      key: null,
      publicKey,
    });
    assert.equal(count, 2);

    const observed = readObservedAttestations(storePath, { key: null, publicKey });
    assert.equal(observed.length, 2);

    // Dropping the revocation from prEntries triggers truncation detection with key: null.
    const trunc = assertNoTruncation({
      prEntries: [approve],
      observedEntries: observed,
      revision: rev,
      key: null,
      publicKey,
      ticket: 'T-ED1',
    });
    assert.equal(trunc.ok, false);
    assert.deepEqual(trunc.missing, [revoke.sig]);

    // Wrong publicKey fails closed (throws).
    assert.throws(
      () => readObservedAttestations(storePath, { key: null, publicKey: wrongPub }),
      /Ed25519 entry.*does not verify/,
    );

    // Absent publicKey with only HMAC key fails closed when store has an Ed25519 entry.
    assert.throws(
      () => readObservedAttestations(storePath, { key: 'legacy-hmac-key', publicKey: null }),
      /Ed25519 entry.*does not verify/,
    );
  });

  it('fails closed on tampered HMAC entry when HMAC key is present', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-store-hmac-tamper-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const adlcDir = join(dir, '.adlc');
    const storePath = join(dir, 'store', 'attestations.jsonl');
    mkdirSync(adlcDir, { recursive: true });
    const hmacKey = 'test-hmac-secret';
    const entry = recordCrossModelReview({
      ticket: 'T-ED1',
      revision: 'git-change:aaa111:ccc333',
      provider: 'openai',
      authorProvider: 'anthropic',
      verdict: 'approve',
      dir: adlcDir,
      key: hmacKey,
    });
    mirrorObservedAttestations({ prEntries: [entry], storePath, key: hmacKey, publicKey: null });
    assert.throws(
      () => readObservedAttestations(storePath, { key: 'wrong-hmac-secret', publicKey: null }),
      /does not verify/,
    );
  });
});

describe('adlc-prosecute CLI & runProsecution — Ed25519 end-to-end zero-secret flow', () => {
  it('mints Ed25519 attestations, carries forward, mirrors, and passes tier-check --trusted-dir with zero secrets', (t) => {
    const repo = makeGitRepo(t, 'adlc-cli-ed25519-');
    const trustedDir = mkdtempSync(join(tmpdir(), 'adlc-trusted-base-'));
    const storeDir = mkdtempSync(join(tmpdir(), 'adlc-ext-store-'));
    t.after(() => {
      rmSync(trustedDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    });

    const { privateKey, publicKey } = generateEd25519KeyPair();
    writeFileSync(join(trustedDir, ADMIN_PUB_FILENAME), publicKey);
    writeFileSync(join(repo, '.adlc', ADMIN_PUB_FILENAME), publicKey);
    git(['add', '.adlc/admin.pub'], repo);
    git(['commit', '-m', 'add admin.pub'], repo);

    // Branch with a trust-root-tier edit.
    git(['checkout', '-b', 'feat/ed25519-test'], repo);
    writeFileSync(join(repo, 'packages', 'prosecute', 'lib', 'sample.mjs'), 'export const v = 2;\n');
    git(['add', 'packages/prosecute/lib/sample.mjs'], repo);
    git(['commit', '-m', 'trust-root edit'], repo);

    // Bare 'agy' approval is rejected fail-closed.
    const bareAgy = runBin([
      'record-cross-model',
      '--ticket', 'T-ED1',
      '--provider', 'agy',
      '--author-provider', 'anthropic',
      '--verdict', 'approve',
      '--base', 'main',
    ], { cwd: repo, env: { ADLC_MANIFEST_PRIVATE_KEY: privateKey } });
    assert.equal(bareAgy.status, 1, bareAgy.stderr);
    assert.match(bareAgy.stderr, /ambiguous/);

    // Record valid Ed25519 approval with model-aware agy:<model>.
    const rec = runBin([
      'record-cross-model',
      '--ticket', 'T-ED1',
      '--provider', 'agy:Gemini 2.5 Pro',
      '--author-provider', 'anthropic',
      '--verdict', 'approve',
      '--base', 'main',
      '--json',
    ], { cwd: repo, env: { ADLC_MANIFEST_PRIVATE_KEY: privateKey } });
    assert.equal(rec.status, 0, rec.stderr);
    const recorded = JSON.parse(rec.stdout);
    assert.equal(recorded.sigAlg, 'ed25519');
    assert.equal(recorded.signed, true);

    const storePath = join(storeDir, 'attestations.jsonl');

    // Mirror attestations with ZERO secrets using --trusted-dir.
    const mirror = runBin([
      'mirror-attestations',
      '--attestation-store', storePath,
      '--dir', '.adlc',
      '--trusted-dir', trustedDir,
      '--json',
    ], { cwd: repo });
    assert.equal(mirror.status, 0, mirror.stderr);
    assert.equal(JSON.parse(mirror.stdout).appended, 1);

    // tier-check passes with ZERO secrets using --trusted-dir and --attestation-store.
    const check = runBin([
      'tier-check',
      '--base', 'main',
      '--author-provider', 'anthropic',
      '--dir', '.adlc',
      '--trusted-dir', trustedDir,
      '--attestation-store', storePath,
      '--json',
    ], { cwd: repo });
    assert.equal(check.status, 0, check.stderr);
    const checkJson = JSON.parse(check.stdout);
    assert.equal(checkJson.trustRootTier, true);
    assert.equal(checkJson.satisfied, true);
    assert.equal(checkJson.keyAvailable, true);
    assert.equal(checkJson.truncationDetected, false);

    // Advance main (new base) and test carry-forward with ADLC_MANIFEST_PRIVATE_KEY.
    const fromRev = recorded.data.revision;
    git(['checkout', 'main'], repo);
    writeFileSync(join(repo, 'README.md'), 'base moved\n');
    git(['add', 'README.md'], repo);
    git(['commit', '-m', 'advance main'], repo);
    git(['checkout', 'feat/ed25519-test'], repo);
    git(['rebase', 'main'], repo);

    const carried = runBin([
      'record-cross-model',
      '--ticket', 'T-ED1',
      '--carry-forward', fromRev,
      '--base', 'main',
      '--trusted-dir', trustedDir,
      '--attestation-store', storePath,
      '--json',
    ], { cwd: repo, env: { ADLC_MANIFEST_PRIVATE_KEY: privateKey } });
    assert.equal(carried.status, 0, carried.stderr);
    const carriedEntry = JSON.parse(carried.stdout);
    assert.equal(carriedEntry.sigAlg, 'ed25519');
    assert.equal(carriedEntry.data.carryDepth, 1);

    // Verify carried-forward entry passes tier-check with ZERO secrets.
    const checkAfterCarry = runBin([
      'tier-check',
      '--base', 'main',
      '--author-provider', 'anthropic',
      '--dir', '.adlc',
      '--trusted-dir', trustedDir,
      '--attestation-store', storePath,
      '--json',
    ], { cwd: repo });
    assert.equal(checkAfterCarry.status, 0, checkAfterCarry.stderr);
    assert.equal(JSON.parse(checkAfterCarry.stdout).satisfied, true);

    // Verify 1-character HMAC key is still accepted in readObservedAttestations (kills key.length > 1 mutant)
    const oneCharStore = join(trustedDir, 'one-char-hmac.jsonl');
    const hmacEntry = {
      seq: 1,
      gate: 'cross-model-review',
      ticket: 'T-1CHAR',
      ts: new Date().toISOString(),
      prev: null,
      files: {},
      data: { revision: 'a'.repeat(40), provider: 'openai', authorProvider: 'anthropic', verdict: 'approve' },
      sigVersion: 2,
    };
    hmacEntry.sig = signEntry('k', hmacEntry);
    writeFileSync(oneCharStore, `${JSON.stringify(hmacEntry)}\n`);
    const oneCharRead = readObservedAttestations(oneCharStore, { key: 'k', publicKey: null });
    assert.equal(oneCharRead.length, 1);
    assert.equal(oneCharRead[0].ticket, 'T-1CHAR');
    const tamperedOneChar = { ...hmacEntry, sig: '00'.repeat(32) };
    writeFileSync(oneCharStore, `${JSON.stringify(tamperedOneChar)}\n`);
    assert.throws(
      () => readObservedAttestations(oneCharStore, { key: 'k', publicKey: null }),
      /does not verify under the given key/,
    );

    // Verify read-side hasCrossModelApprove & hasCrossModelApproveForRevision succeed with key: null via trustedDir.
    const carriedRev = carriedEntry.data.revision;
    assert.equal(
      hasCrossModelApprove({
        dir: join(repo, '.adlc'),
        ticket: 'T-ED1',
        revision: carriedRev,
        authorProvider: 'anthropic',
        key: null,
        trustedDir,
      }),
      true,
    );
    assert.equal(
      hasCrossModelApproveForRevision({
        dir: join(repo, '.adlc'),
        revision: carriedRev,
        authorProvider: 'anthropic',
        key: null,
        trustedDir,
      }),
      true,
    );

    // Verify runProsecution & adlc-prosecute --input pass trust-root-tier gate with Ed25519 signing + trustedDir.
    const transcriptRel = '.adlc/p5-transcript.txt';
    const promptRel = '.adlc/p5-prompt.txt';
    const inputsRel = '.adlc/p5-inputs.txt';
    const inputRel = '.adlc/p5-input.json';
    const transcriptText = `ticket: T-ED1\nrevision: ${carriedRev}\nverified three clean dry passes with zero findings across correctness, security, and contract lenses.\n`;
    const promptText = 'Prosecute packages/prosecute/lib/sample.mjs for T-ED1.\n';
    const inputsText = 'export const v = 2;\n';
    writeFileSync(join(repo, transcriptRel), transcriptText);
    writeFileSync(join(repo, promptRel), promptText);
    writeFileSync(join(repo, inputsRel), inputsText);
    const dryInput = {
      target: 'packages/prosecute/lib/sample.mjs',
      provenance: {
        reviewer: 'adversarial-prosecutor',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        session: 'sess-ed25519-test',
        command: 'adlc prosecute --input .adlc/p5-input.json',
        transcript: transcriptRel,
      },
      review_packet: {
        prompt: promptRel,
        prompt_hash: sha256(promptText),
        inputs: inputsRel,
        inputs_hash: sha256(inputsText),
        clean_worktree: carriedRev,
      },
      no_findings_attestation: {
        reason: 'All three passes completed dry with zero findings.',
        method: 'adversarial-review',
        evidence: 'Checked sample.mjs diff, exports, and callers across correctness, security, and contract lenses.',
      },
      passes: [
        { lens: 'correctness', findings: [], dry_evidence: 'Verified sample.mjs export and callers.' },
        { lens: 'security', findings: [], dry_evidence: 'Checked trust boundary and signature handling.' },
        { lens: 'contract', findings: [], dry_evidence: 'Verified exported contract matches tests.' },
      ],
    };
    writeFileSync(join(repo, inputRel), JSON.stringify(dryInput, null, 2));
    const prosResult = runProsecution(dryInput, {
      ticket: 'T-ED1',
      key: privateKey,
      trustedDir,
      dir: '.adlc',
      cwd: repo,
      base: 'main',
      inputPath: inputRel,
      requireCrossModel: true,
      authorProvider: 'anthropic',
    });
    assert.equal(prosResult.exitCode, 0, prosResult.message ?? prosResult.errors?.join('; '));
    assert.equal(prosResult.status, 'pass');

    // Subprocess adlc-prosecute --input also passes with ADLC_MANIFEST_PRIVATE_KEY and --trusted-dir.
    const cliPros = runBin([
      '--input', inputRel,
      '--ticket', 'T-ED1',
      '--base', 'main',
      '--author-provider', 'anthropic',
      '--trusted-dir', trustedDir,
      '--json',
    ], { cwd: repo, env: { ADLC_MANIFEST_PRIVATE_KEY: privateKey } });
    assert.equal(cliPros.status, 0, cliPros.stderr);
    assert.equal(JSON.parse(cliPros.stdout).status, 'pass');
  });

  it('rejects PR-forged .adlc/admin.pub when --trusted-dir has a different or absent admin.pub', (t) => {
    const repo = makeGitRepo(t, 'adlc-cli-forged-pub-');
    const trustedWithRealKey = mkdtempSync(join(tmpdir(), 'adlc-trusted-real-'));
    const trustedEmpty = mkdtempSync(join(tmpdir(), 'adlc-trusted-empty-'));
    t.after(() => {
      rmSync(trustedWithRealKey, { recursive: true, force: true });
      rmSync(trustedEmpty, { recursive: true, force: true });
    });

    const realKp = generateEd25519KeyPair();
    const attackerKp = generateEd25519KeyPair();
    writeFileSync(join(trustedWithRealKey, ADMIN_PUB_FILENAME), realKp.publicKey);

    git(['checkout', '-b', 'feat/forged-pub'], repo);
    // Attacker overwrites PR's .adlc/admin.pub with their own public key and signs with attacker private key.
    writeFileSync(join(repo, '.adlc', ADMIN_PUB_FILENAME), attackerKp.publicKey);
    writeFileSync(join(repo, 'packages', 'prosecute', 'lib', 'sample.mjs'), 'export const v = 999;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'attacker PR'], repo);

    const rec = runBin([
      'record-cross-model',
      '--ticket', 'T-ED1',
      '--provider', 'agy:Gemini 2.5 Pro',
      '--author-provider', 'anthropic',
      '--verdict', 'approve',
      '--base', 'main',
    ], { cwd: repo, env: { ADLC_MANIFEST_PRIVATE_KEY: attackerKp.privateKey } });
    assert.equal(rec.status, 0, rec.stderr);

    // Against trustedWithRealKey -> FAILS CLOSED (exit 2).
    const checkReal = runBin([
      'tier-check',
      '--base', 'main',
      '--author-provider', 'anthropic',
      '--dir', '.adlc',
      '--trusted-dir', trustedWithRealKey,
      '--json',
    ], { cwd: repo });
    assert.equal(checkReal.status, 2);
    assert.equal(JSON.parse(checkReal.stdout).satisfied, false);

    // Against trustedEmpty (no admin.pub in --trusted-dir) -> MUST NOT fall back to PR's .adlc/admin.pub!
    const checkEmpty = runBin([
      'tier-check',
      '--base', 'main',
      '--author-provider', 'anthropic',
      '--dir', '.adlc',
      '--trusted-dir', trustedEmpty,
      '--json',
    ], { cwd: repo });
    assert.equal(checkEmpty.status, 2);
    const emptyJson = JSON.parse(checkEmpty.stdout);
    assert.equal(emptyJson.satisfied, false);
    assert.equal(emptyJson.keyAvailable, false);
  });

  it('rejects truncated Ed25519 revocation via --attestation-store and --trusted-dir with zero secrets', (t) => {
    const repo = makeGitRepo(t, 'adlc-cli-trunc-ed25519-');
    const trustedDir = mkdtempSync(join(tmpdir(), 'adlc-trusted-trunc-'));
    const storeDir = mkdtempSync(join(tmpdir(), 'adlc-store-trunc-'));
    t.after(() => {
      rmSync(trustedDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    });

    const { privateKey, publicKey } = generateEd25519KeyPair();
    writeFileSync(join(trustedDir, ADMIN_PUB_FILENAME), publicKey);
    writeFileSync(join(repo, '.adlc', ADMIN_PUB_FILENAME), publicKey);
    git(['add', '.adlc/admin.pub'], repo);
    git(['commit', '-m', 'add admin.pub'], repo);

    git(['checkout', '-b', 'feat/trunc-test'], repo);
    writeFileSync(join(repo, 'packages', 'prosecute', 'lib', 'sample.mjs'), 'export const v = 42;\n');
    git(['add', 'packages/prosecute/lib/sample.mjs'], repo);
    git(['commit', '-m', 'trust-root change'], repo);

    // Record approve, snapshot manifest, record revocation, mirror both to external store, then truncate manifest back.
    const approveRes = runBin([
      'record-cross-model',
      '--ticket', 'T-ED1',
      '--provider', 'agy:Gemini 2.5 Pro',
      '--author-provider', 'anthropic',
      '--verdict', 'approve',
      '--base', 'main',
    ], { cwd: repo, env: { ADLC_MANIFEST_PRIVATE_KEY: privateKey } });
    assert.equal(approveRes.status, 0, approveRes.stderr);

    const manifestPath = join(repo, '.adlc', 'manifest.jsonl');
    const manifestBeforeRevoke = readFileSync(manifestPath, 'utf8');

    const revokeRes = runBin([
      'record-cross-model',
      '--ticket', 'T-ED1',
      '--provider', 'agy:Gemini 2.5 Pro',
      '--author-provider', 'anthropic',
      '--verdict', 'needs-attention',
      '--base', 'main',
    ], { cwd: repo, env: { ADLC_MANIFEST_PRIVATE_KEY: privateKey } });
    assert.equal(revokeRes.status, 0, revokeRes.stderr);

    const storePath = join(storeDir, 'attestations.jsonl');
    const mirrorRes = runBin([
      'mirror-attestations',
      '--attestation-store', storePath,
      '--dir', '.adlc',
      '--trusted-dir', trustedDir,
    ], { cwd: repo });
    assert.equal(mirrorRes.status, 0, mirrorRes.stderr);

    // Attacker truncates PR manifest to drop the revocation.
    writeFileSync(manifestPath, manifestBeforeRevoke);

    const checkRes = runBin([
      'tier-check',
      '--base', 'main',
      '--author-provider', 'anthropic',
      '--dir', '.adlc',
      '--trusted-dir', trustedDir,
      '--attestation-store', storePath,
      '--json',
    ], { cwd: repo });
    assert.equal(checkRes.status, 2);
    const parsed = JSON.parse(checkRes.stdout);
    assert.equal(parsed.satisfied, false);
    assert.equal(parsed.truncationDetected, true);
  });
});
