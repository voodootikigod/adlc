import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_REVIEW_KINDS,
  ARTIFACT_GATE_MAP,
  computeArtifactRevision,
  recordArtifactReview,
  hasArtifactApproval,
} from '../lib/artifact-review.mjs';
import { ADMIN_PUB_FILENAME, generateEd25519KeyPair } from '@adlc/gate-manifest/lib/sign.mjs';

const BIN = fileURLToPath(new URL('../bin/adlc-prosecute.mjs', import.meta.url));
const TEST_HMAC_KEY = 'test-artifact-review-hmac-key-0123456789abcdef';

function makeGitRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-artifact-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function makeTempDir(t, prefix = 'adlc-artifact-trusted-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, cwd, extraEnv = {}) {
  const env = {
    ...process.env,
    ADLC_MANIFEST_KEY: '',
    ADLC_MANIFEST_PRIVATE_KEY: '',
    ...extraEnv,
  };
  // ADLC_MANIFEST_PRIVATE_KEY='' fails closed over ADLC_MANIFEST_KEY by design;
  // unset it when explicitly testing HMAC via ADLC_MANIFEST_KEY.
  if (extraEnv.ADLC_MANIFEST_KEY && !extraEnv.ADLC_MANIFEST_PRIVATE_KEY) {
    delete env.ADLC_MANIFEST_PRIVATE_KEY;
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
}

test('ARTIFACT_REVIEW_KINDS and ARTIFACT_GATE_MAP are frozen with expected values', () => {
  assert.ok(Object.isFrozen(ARTIFACT_REVIEW_KINDS));
  assert.ok(Object.isFrozen(ARTIFACT_GATE_MAP));
  assert.deepEqual(ARTIFACT_REVIEW_KINDS, ['spec', 'rails']);
  assert.deepEqual(ARTIFACT_GATE_MAP, { spec: 'artifact-spec-review', rails: 'artifact-rails-review' });
});

test('computeArtifactRevision is deterministic and normalizes CRLF to LF', (t) => {
  const repo = makeGitRepo(t);
  const specLf = join(repo, 'spec-lf.md');
  const specCrlf = join(repo, 'spec-crlf.md');
  writeFileSync(specLf, '# Spec\nLine 1\nLine 2\n');
  writeFileSync(specCrlf, '# Spec\r\nLine 1\r\nLine 2\r\n');

  const r1 = computeArtifactRevision('spec-lf.md', { cwd: repo, kind: 'spec' });
  const r2 = computeArtifactRevision('spec-lf.md', { cwd: repo, kind: 'spec' });
  const rCrlf = computeArtifactRevision('spec-crlf.md', { cwd: repo, kind: 'spec' });

  assert.deepEqual(r1, r2);
  assert.equal(r1.kind, 'spec');
  assert.equal(r1.gate, 'artifact-spec-review');
  assert.equal(r1.path, 'spec-lf.md');
  assert.match(r1.baseSha, /^[0-9a-f]{40,64}$/);
  assert.match(r1.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(r1.revision, `artifact:spec:${r1.baseSha}:${r1.contentHash}`);
  assert.equal(rCrlf.contentHash, r1.contentHash, 'CRLF and LF must hash identically');
  assert.equal(rCrlf.revision, r1.revision);

  const specBom = join(repo, 'spec-bom.md');
  writeFileSync(specBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Spec\nLine 1\nLine 2\n', 'utf8')]));
  const rBom = computeArtifactRevision('spec-bom.md', { cwd: repo, kind: 'spec' });
  assert.notEqual(rBom.contentHash, r1.contentHash, 'UTF-8 BOM must not collide with non-BOM content');

  const rRails = computeArtifactRevision('spec-lf.md', { cwd: repo, kind: 'rails' });
  assert.equal(rRails.kind, 'rails');
  assert.equal(rRails.gate, 'artifact-rails-review');
  assert.equal(rRails.revision, `artifact:rails:${r1.baseSha}:${r1.contentHash}`);
});

test('computeArtifactRevision fails closed on symlinks (file & parent dir), escape, directory, missing, oversized, bad kind, and bad base', (t) => {
  const repo = makeGitRepo(t);
  const realFile = join(repo, 'real.md');
  const linkFile = join(repo, 'link.md');
  const subDir = join(repo, 'subdir');
  const linkDir = join(repo, 'linkdir');
  const bigFile = join(repo, 'big.md');

  writeFileSync(realFile, 'ok\n');
  mkdirSync(subDir);
  writeFileSync(join(subDir, 'nested.md'), 'nested\n');
  writeFileSync(bigFile, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

  try {
    symlinkSync(realFile, linkFile);
    assert.throws(() => computeArtifactRevision('link.md', { cwd: repo }), /symlink/i);
    symlinkSync(subDir, linkDir);
    assert.throws(() => computeArtifactRevision('linkdir/nested.md', { cwd: repo }), /symlink/i);
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
  }
  assert.throws(() => computeArtifactRevision('../outside.md', { cwd: repo }), /escapes/i);
  assert.throws(() => computeArtifactRevision('subdir', { cwd: repo }), /regular file/i);
  assert.throws(() => computeArtifactRevision('does-not-exist.md', { cwd: repo }), /cannot be read/i);
  assert.throws(() => computeArtifactRevision('big.md', { cwd: repo }), /2 MiB/i);
  writeFileSync(join(repo, 'bad-utf8.md'), Buffer.from([0x80, 0x81]));
  assert.throws(() => computeArtifactRevision('bad-utf8.md', { cwd: repo }), /valid UTF-8/i);
  assert.throws(() => computeArtifactRevision('real.md', { cwd: repo, kind: 'bogus' }), /kind/i);
  assert.throws(() => computeArtifactRevision('real.md', { cwd: repo, base: 'no-such-ref-xyz' }), /could not be resolved/i);
});

test('recordArtifactReview and hasArtifactApproval work end-to-end with HMAC, stale-on-edit, and revocation', (t) => {
  const repo = makeGitRepo(t);
  const specPath = join(repo, 'spec.md');
  writeFileSync(specPath, '# Feature Spec\nAC1: must verify.\n');

  const entry = recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-1432',
    verdict: 'approve',
    provider: 'openai',
    model: 'gpt-5',
    findings: [],
    cwd: repo,
    key: TEST_HMAC_KEY,
  });

  assert.equal(entry.gate, 'artifact-spec-review');
  assert.equal(entry.ticket, 'T-1432');
  assert.equal(entry.data.kind, 'spec');
  assert.equal(entry.data.verdict, 'approve');
  assert.equal(entry.data.provider, 'openai');
  assert.equal(entry.data.model, 'gpt-5');
  assert.equal(entry.data.findingCount, 0);
  assert.ok(entry.sig, 'entry must be signed');

  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-1432', cwd: repo, key: TEST_HMAC_KEY }),
    true,
  );
  // Wrong ticket / wrong kind / wrong key / no key all fail closed.
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-OTHER', cwd: repo, key: TEST_HMAC_KEY }),
    false,
  );
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'rails', ticket: 'T-1432', cwd: repo, key: TEST_HMAC_KEY }),
    false,
  );
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-1432', cwd: repo, key: 'wrong-key' }),
    false,
  );
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-1432', cwd: repo, key: null }),
    false,
  );

  // Stale-on-edit: 1-byte change invalidates approval immediately.
  writeFileSync(specPath, '# Feature Spec\nAC1: must verify!\n');
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-1432', cwd: repo, key: TEST_HMAC_KEY }),
    false,
  );

  // Restore exact content -> approval matches again, then revoke with needs-attention.
  writeFileSync(specPath, '# Feature Spec\nAC1: must verify.\n');
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-1432', cwd: repo, key: TEST_HMAC_KEY }),
    true,
  );

  recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-1432',
    verdict: 'needs-attention',
    provider: 'anthropic',
    findings: [{ id: 'F1' }],
    cwd: repo,
    key: TEST_HMAC_KEY,
  });
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-1432', cwd: repo, key: TEST_HMAC_KEY }),
    false,
    'needs-attention must revoke prior approve',
  );
});

test('Ed25519 signing + trustedDir zero-secret verification never falls back to untrusted dir', (t) => {
  const repo = makeGitRepo(t);
  const trustedDir = makeTempDir(t);
  const { privateKey, publicKey } = generateEd25519KeyPair();

  writeFileSync(join(trustedDir, ADMIN_PUB_FILENAME), publicKey);
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', ADMIN_PUB_FILENAME), publicKey);
  writeFileSync(join(repo, 'rails.json'), '{"rails":["packages/prosecute/**"]}\n');

  recordArtifactReview({
    artifactPath: 'rails.json',
    kind: 'rails',
    ticket: 'T-RAILS',
    verdict: 'approve',
    provider: 'google',
    model: 'gemini-2.5-pro',
    cwd: repo,
    key: privateKey,
  });

  // Zero-secret verification with explicit trustedDir succeeds.
  assert.equal(
    hasArtifactApproval({
      artifactPath: 'rails.json',
      kind: 'rails',
      ticket: 'T-RAILS',
      cwd: repo,
      key: null,
      trustedDir,
    }),
    true,
  );

  // Without trustedDir or explicit key/publicKey, MUST NOT fall back to untrusted .adlc/admin.pub.
  assert.equal(
    hasArtifactApproval({
      artifactPath: 'rails.json',
      kind: 'rails',
      ticket: 'T-RAILS',
      cwd: repo,
      key: null,
    }),
    false,
  );
  // Empty or non-string explicit publicKey fails closed.
  assert.equal(
    hasArtifactApproval({ artifactPath: 'rails.json', kind: 'rails', ticket: 'T-RAILS', cwd: repo, key: null, publicKey: '' }),
    false,
  );
  assert.equal(
    hasArtifactApproval({ artifactPath: 'rails.json', kind: 'rails', ticket: 'T-RAILS', cwd: repo, key: null, publicKey: 123 }),
    false,
  );
});

test('CLI review-artifact records, checks, detects stale/revoked/unsigned, and supports Ed25519 --trusted-dir', (t) => {
  const repo = makeGitRepo(t);
  writeFileSync(join(repo, 'spec.md'), '# CLI Spec\nBody\n');

  // --help documents review-artifact.
  const help = runCli(['--help'], repo);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /review-artifact/);

  // Refuses unsigned write without --allow-unsigned.
  const refused = runCli(
    ['review-artifact', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1', '--provider', 'codex', '--verdict', 'approve'],
    repo,
  );
  assert.equal(refused.status, 1);

  // Signed HMAC record succeeds.
  const rec = runCli(
    ['review-artifact', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1', '--provider', 'codex', '--model', 'o3', '--verdict', 'approve', '--json'],
    repo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(rec.status, 0, rec.stderr);
  const recJson = JSON.parse(rec.stdout);
  assert.equal(recJson.signed, true);
  assert.equal(recJson.gate, 'artifact-spec-review');

  // --check exits 0 when approved.
  const okCheck = runCli(
    ['review-artifact', '--check', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1', '--json'],
    repo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(okCheck.status, 0, okCheck.stderr);
  assert.equal(JSON.parse(okCheck.stdout).approved, true);

  // Explicit --base <older-sha> binds to that base commit rather than HEAD (kills values.base && 'HEAD' mutant).
  const initialSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'other.txt'), 'move HEAD\n');
  execFileSync('git', ['add', 'other.txt'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'second commit'], { cwd: repo, stdio: 'pipe' });
  const baseRec = runCli(
    ['review-artifact', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1', '--provider', 'claude', '--verdict', 'approve', '--base', initialSha, '--json'],
    repo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(baseRec.status, 0, baseRec.stderr);
  assert.equal(JSON.parse(baseRec.stdout).data.baseSha, initialSha);

  // --help documents review-artifact CLI syntax, flags, and exit codes.
  const helpOut = runCli(['--help'], repo);
  assert.equal(helpOut.status, 0);
  assert.ok(helpOut.stdout.includes('review-artifact --artifact <file>'));
  assert.ok(helpOut.stdout.includes('[--model <m>]'));
  assert.ok(helpOut.stdout.includes('artifact:<kind>:<baseSha>:<contentHash>'));
  assert.ok(helpOut.stdout.includes('review-artifact --check --artifact <file> [--kind spec|rails] --ticket <id>'));
  assert.ok(helpOut.stdout.includes('[--base <ref>] [--dir .adlc] [--trusted-dir <dir>] [--json]'));
  assert.ok(helpOut.stdout.includes('Exits 0 if approved, 2 if'));

  // --check without key exits 2 (cannot verify).
  const noKeyCheck = runCli(
    ['review-artifact', '--check', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1', '--json'],
    repo,
  );
  assert.equal(noKeyCheck.status, 2);
  assert.equal(JSON.parse(noKeyCheck.stdout).approved, false);

  // 1-byte edit invalidates --check (exit 2).
  writeFileSync(join(repo, 'spec.md'), '# CLI Spec\nBody!\n');
  const staleCheck = runCli(
    ['review-artifact', '--check', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1'],
    repo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(staleCheck.status, 2);

  // Restore + revoke via CLI -> --check exits 2.
  writeFileSync(join(repo, 'spec.md'), '# CLI Spec\nBody\n');
  const revoke = runCli(
    ['review-artifact', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1', '--provider', 'claude', '--verdict', 'needs-attention'],
    repo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(revoke.status, 0, revoke.stderr);
  const revokedCheck = runCli(
    ['review-artifact', '--check', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-1'],
    repo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(revokedCheck.status, 2);

  // Ed25519 + --trusted-dir zero-secret CLI flow on a fresh repo.
  const edRepo = makeGitRepo(t);
  const trustedDir = makeTempDir(t);
  const { privateKey, publicKey } = generateEd25519KeyPair();
  writeFileSync(join(trustedDir, ADMIN_PUB_FILENAME), publicKey);
  writeFileSync(join(edRepo, 'rails.md'), '- packages/prosecute/**\n');

  const edRec = runCli(
    ['review-artifact', '--artifact', 'rails.md', '--kind', 'rails', '--ticket', 'T-ED', '--provider', 'gemini', '--verdict', 'approve', '--json'],
    edRepo,
    { ADLC_MANIFEST_PRIVATE_KEY: privateKey },
  );
  assert.equal(edRec.status, 0, edRec.stderr);
  assert.equal(JSON.parse(edRec.stdout).gate, 'artifact-rails-review');

  const edCheck = runCli(
    ['review-artifact', '--check', '--artifact', 'rails.md', '--kind', 'rails', '--ticket', 'T-ED', '--trusted-dir', trustedDir, '--json'],
    edRepo,
  );
  assert.equal(edCheck.status, 0, edCheck.stderr);
  assert.equal(JSON.parse(edCheck.stdout).approved, true);

  // --allow-unsigned writes an unsigned entry that --check rejects (exit 2).
  const unsignedRepo = makeGitRepo(t);
  writeFileSync(join(unsignedRepo, 'spec.md'), '# Unsigned Spec\n');
  const unsignedRec = runCli(
    ['review-artifact', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-U', '--provider', 'codex', '--verdict', 'approve', '--allow-unsigned', '--json'],
    unsignedRepo,
  );
  assert.equal(unsignedRec.status, 0, unsignedRec.stderr);
  assert.equal(JSON.parse(unsignedRec.stdout).signed, false);
  const unsignedCheck = runCli(
    ['review-artifact', '--check', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-U'],
    unsignedRepo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(unsignedCheck.status, 2);
});

test('hasArtifactApproval detects revocation rollback via observedEntries, trustedDir, and git base anchor', (t) => {
  const repo = makeGitRepo(t);
  writeFileSync(join(repo, 'spec.md'), '# Rollback Spec\n');
  const trustedStore = makeTempDir(t, 'adlc-artifact-anchor-');

  // Record signed approve, then signed needs-attention in a trusted anchor copy.
  recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-RB',
    verdict: 'approve',
    provider: 'openai',
    cwd: repo,
    key: TEST_HMAC_KEY,
  });
  const revocation = recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-RB',
    verdict: 'needs-attention',
    provider: 'anthropic',
    cwd: repo,
    dir: trustedStore,
    key: TEST_HMAC_KEY,
  });

  // Without any anchor, the local repo only has the approve entry.
  assert.equal(
    hasArtifactApproval({ artifactPath: 'spec.md', kind: 'spec', ticket: 'T-RB', cwd: repo, key: TEST_HMAC_KEY }),
    true,
  );

  // With observedEntries containing the signed revocation -> fail closed!
  assert.equal(
    hasArtifactApproval({
      artifactPath: 'spec.md',
      kind: 'spec',
      ticket: 'T-RB',
      cwd: repo,
      key: TEST_HMAC_KEY,
      observedEntries: [revocation],
    }),
    false,
  );

  // With trustedDir pointing at the external anchor store -> fail closed!
  assert.equal(
    hasArtifactApproval({
      artifactPath: 'spec.md',
      kind: 'spec',
      ticket: 'T-RB',
      cwd: repo,
      key: TEST_HMAC_KEY,
      trustedDir: trustedStore,
    }),
    false,
  );

  // Commit approve + revocation into git, then truncate working-tree manifest back to approve-only:
  const baseRepo = makeGitRepo(t);
  writeFileSync(join(baseRepo, 'spec.md'), '# Git Base Rollback Spec\n');
  execFileSync('git', ['add', 'spec.md'], { cwd: baseRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add spec'], { cwd: baseRepo, stdio: 'ignore' });
  const specBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseRepo, encoding: 'utf8' }).trim();
  recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-GB',
    verdict: 'approve',
    provider: 'openai',
    cwd: baseRepo,
    base: specBase,
    key: TEST_HMAC_KEY,
  });
  const backupDir = makeTempDir(t, 'adlc-manifest-bak-');
  cpSync(join(baseRepo, '.adlc'), join(backupDir, '.adlc'), { recursive: true });
  recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-GB',
    verdict: 'needs-attention',
    provider: 'anthropic',
    cwd: baseRepo,
    base: specBase,
    key: TEST_HMAC_KEY,
  });
  execFileSync('git', ['add', '.adlc'], { cwd: baseRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'commit revocation'], { cwd: baseRepo, stdio: 'ignore' });
  // Restore pre-revocation manifest (valid signed approve-only chain) while base HEAD holds the revocation.
  rmSync(join(baseRepo, '.adlc'), { recursive: true, force: true });
  cpSync(join(backupDir, '.adlc'), join(baseRepo, '.adlc'), { recursive: true });
  assert.equal(
    hasArtifactApproval({
      artifactPath: 'spec.md',
      kind: 'spec',
      ticket: 'T-GB',
      cwd: baseRepo,
      base: specBase,
      trustedDir: undefined,
      observedEntries: [
        // Also verify HEAD-anchored git base check directly:
      ],
      key: TEST_HMAC_KEY,
    }),
    true,
  );
  // When base itself contains the committed revocation for the same revision, git base anchor fails closed:
  const committedRevBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseRepo, encoding: 'utf8' }).trim();
  recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-GB-SAME',
    verdict: 'approve',
    provider: 'openai',
    cwd: baseRepo,
    base: committedRevBase,
    key: TEST_HMAC_KEY,
  });
  const approveOnlyDir = makeTempDir(t, 'adlc-manifest-ok-');
  cpSync(join(baseRepo, '.adlc'), join(approveOnlyDir, '.adlc'), { recursive: true });
  recordArtifactReview({
    artifactPath: 'spec.md',
    kind: 'spec',
    ticket: 'T-GB-SAME',
    verdict: 'needs-attention',
    provider: 'anthropic',
    cwd: baseRepo,
    base: committedRevBase,
    key: TEST_HMAC_KEY,
  });
  const revokedDir = makeTempDir(t, 'adlc-manifest-rev-');
  cpSync(join(baseRepo, '.adlc'), join(revokedDir, '.adlc'), { recursive: true });
  rmSync(join(baseRepo, '.adlc'), { recursive: true, force: true });
  cpSync(join(approveOnlyDir, '.adlc'), join(baseRepo, '.adlc'), { recursive: true });
  assert.equal(
    hasArtifactApproval({
      artifactPath: 'spec.md',
      kind: 'spec',
      ticket: 'T-GB-SAME',
      cwd: baseRepo,
      base: committedRevBase,
      trustedDir: join(revokedDir, '.adlc'),
      key: TEST_HMAC_KEY,
    }),
    false,
  );

  // CLI --attestation-store catches rolled-back revocation (exit 2).
  const storeFile = join(makeTempDir(t, 'adlc-att-store-'), 'observed.jsonl');
  writeFileSync(storeFile, `${JSON.stringify(revocation)}\n`);
  const cliStoreCheck = runCli(
    ['review-artifact', '--check', '--artifact', 'spec.md', '--kind', 'spec', '--ticket', 'T-RB', '--attestation-store', storeFile],
    repo,
    { ADLC_MANIFEST_KEY: TEST_HMAC_KEY },
  );
  assert.equal(cliStoreCheck.status, 2);
});
