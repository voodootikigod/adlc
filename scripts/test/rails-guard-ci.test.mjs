// rails-guard-ci.test.mjs — the CI rail-freeze backstop is the unbypassable
// commit-time gate, so it gets a committed regression test. Builds throwaway git
// repos and drives the real script. Offline, leaves no trace.
//
// The load-bearing property: the rail set is read from the TRUSTED BASE ref, so a
// PR that removes rails (or edits the ticket trust root) while touching a frozen
// path is still rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'rails-guard-ci.mjs');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Build a repo whose base (main) has `baseTickets` and a file at each
 * `seedFiles` path, then apply `mutate(dir)` on a feature branch. Returns the
 * script's exit code when run with base=main.
 */
function runScenario({ baseTickets, seedFiles, mutate, seedFileContents = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'rgci-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), baseTickets);
    for (const f of seedFiles) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      writeFileSync(join(dir, f), seedFileContents[f] ?? 'orig\n');
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    mutate(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'change']);
    try {
      execFileSync(process.execPath, [SCRIPT, 'main'], { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status ?? 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RAILED = JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }] });
const VALID_CONFIG = JSON.stringify({
  acknowledgedNewRailBypass: true,
  trustedCodeownersAttested: true,
  securityMode: 'unsigned-fallback',
  signers: { alice: { role: 'builder' } },
  revokedKeys: ['old-key'],
  securitySensitivePatterns: ['src/security/**'],
  maxBundleAgeDays: 14,
});
const SIGNED_CONFIG = JSON.stringify({
  acknowledgedNewRailBypass: true,
  trustedCodeownersAttested: true,
  securityMode: 'signed',
  signedEvidenceRequired: true,
  runnerBinarySha256: '0'.repeat(64),
  signers: { alice: { roles: ['builder'] } },
});

test('ATTACK: PR empties rails AND edits a formerly-frozen file → exit 2 (base rails enforced)', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => {
      writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
      writeFileSync(join(d, 'src/critical/auth.mjs'), 'WEAKENED\n');
    },
  });
  assert.equal(code, 2);
});

test('mutable state: PR adds a new ticket while preserving existing tickets → exit 0', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) =>
      writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }, { id: 'T2' }] })),
  });
  assert.equal(code, 0);
});

test('mutable state: PR removes a base rail from tickets → exit 2', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] })),
  });
  assert.equal(code, 2);
});

test('mutable state: PR changes an existing ticket contract while preserving rails → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', triageClass: 'Substantial', triageCommit: 'abc123', rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'tickets.json'),
        JSON.stringify({ tickets: [{ id: 'T1', triageClass: 'Trivial', triageCommit: 'abc123', rails: ['src/critical/**'] }] })
      ),
  });
  assert.equal(code, 2);
});

test('trust root: PR edits .adlc/config.json while base rails exist → exit 2', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'config.json'), '{"securityMode":"unsigned-fallback"}\n'),
  });
  assert.equal(code, 2);
});

test('trust root: PR edits .adlc/admin.pub (admin recovery key) while base rails exist → exit 2', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/admin.pub'],
    seedFileContents: { '.adlc/admin.pub': 'ssh-ed25519 AAAAbase-fingerprint\n' },
    mutate: (d) => writeFileSync(join(d, '.adlc', 'admin.pub'), 'ssh-ed25519 AAAAforged-fingerprint\n'),
  });
  assert.equal(code, 2);
});

test('trust root: PR edits .adlc/admin.pub even when no ticket rails exist → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', '.adlc/admin.pub', 'src/app.mjs'],
    seedFileContents: {
      '.adlc/config.json': `${VALID_CONFIG}\n`,
      '.adlc/admin.pub': 'ssh-ed25519 AAAAbase-fingerprint\n',
    },
    mutate: (d) => writeFileSync(join(d, '.adlc', 'admin.pub'), 'ssh-ed25519 AAAAforged-fingerprint\n'),
  });
  assert.equal(code, 2);
});

test('mutable state: PR creates manifest evidence when base has no manifest → exit 2', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'manifest.jsonl'), '{"evidence":"changed"}\n'),
  });
  assert.equal(code, 2);
});

test('mutable state: PR appends manifest evidence → exit 0', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': '{"seq":1}\n' },
    mutate: (d) => writeFileSync(join(d, '.adlc', 'manifest.jsonl'), '{"seq":1}\n{"seq":2}\n'),
  });
  assert.equal(code, 0);
});

test('mutable state: PR rewrites existing manifest evidence → exit 2', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': '{"seq":1}\n' },
    mutate: (d) => writeFileSync(join(d, '.adlc', 'manifest.jsonl'), '{"seq":0}\n{"seq":2}\n'),
  });
  assert.equal(code, 2);
});

test('trust root: PR edits deployed rails guard workflow while base rails exist → exit 2', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs', '.github/workflows/adlc-rails-guard.yml'],
    mutate: (d) => writeFileSync(join(d, '.github/workflows/adlc-rails-guard.yml'), 'jobs: {}\n'),
  });
  assert.equal(code, 2);
});

for (const [path, renamedPath] of [
  ['.adlc/tickets.json', 'tickets-renamed.json'],
  ['.adlc/manifest.jsonl', 'manifest-renamed.jsonl'],
  ['.adlc/admin.pub', '.adlc/admin-renamed.pub'],
  ['CODEOWNERS', 'CODEOWNERS.renamed'],
  ['.github/workflows/adlc-rails-guard.yml', '.github/workflows/renamed.yml'],
]) {
  test(`trust root: PR renames ${path} → exit 2`, () => {
    const seedFiles = ['src/critical/auth.mjs'];
    if (path !== '.adlc/tickets.json') seedFiles.push(path);
    const code = runScenario({
      baseTickets: RAILED,
      seedFiles,
      mutate: (d) => renameSync(join(d, path), join(d, renamedPath)),
    });
    assert.equal(code, 2);
  });

  test(`trust root: PR deletes ${path} → exit 2`, () => {
    const seedFiles = ['src/critical/auth.mjs'];
    if (path !== '.adlc/tickets.json') seedFiles.push(path);
    const code = runScenario({
      baseTickets: RAILED,
      seedFiles,
      mutate: (d) => unlinkSync(join(d, path)),
    });
    assert.equal(code, 2);
  });
}

test('trust root: PR edits .adlc/config.json even when no ticket rails exist → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), skipRailEnforcement: true })}\n`
      ),
  });
  assert.equal(code, 2);
});

test('standalone semantic gate blocks signed securityMode downgrade → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${SIGNED_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(SIGNED_CONFIG), securityMode: 'unsigned-fallback', signedEvidenceRequired: false })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks signed securityMode upgrade without ceremony → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), securityMode: 'signed', signedEvidenceRequired: true, runnerBinarySha256: '0'.repeat(64) })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks trusted CODEOWNERS attestation removal → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), trustedCodeownersAttested: false })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks unknown head securityMode → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), securityMode: 'permissive-override' })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks unknown base securityMode → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), securityMode: 'permissive-override' })}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), securityMode: 'unsigned-fallback' })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks existing signer deletion → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), signers: {} })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks revokedKeys removal → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), revokedKeys: [] })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks securitySensitivePatterns removal → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), securitySensitivePatterns: [] })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks maxBundleAgeDays increase → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), maxBundleAgeDays: 30 })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks post-bootstrap signer additions → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), signers: { ...JSON.parse(VALID_CONFIG).signers, bob: { role: 'critic' } } })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks undeclared fields on new signers → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), signers: { ...JSON.parse(VALID_CONFIG).signers, bob: { role: 'builder', canBypassRails: true } } })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks undeclared fields on existing signers → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${VALID_CONFIG}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), signers: { alice: { role: 'builder', adminOverride: true } } })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate blocks trusted signer field removal → exit 1', () => {
  const baseConfig = JSON.stringify({
    acknowledgedNewRailBypass: true,
    securityMode: 'unsigned-fallback',
    signers: { alice: { role: 'builder', publicKey: 'abc123' } },
  });
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${baseConfig}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ acknowledgedNewRailBypass: true, securityMode: 'unsigned-fallback', signers: { alice: { role: 'builder' } } })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('standalone semantic gate rejects null signers field → exit 1', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['.adlc/config.json', 'src/app.mjs'],
    seedFileContents: { '.adlc/config.json': `${JSON.stringify({ acknowledgedNewRailBypass: true, securityMode: 'unsigned-fallback' })}\n` },
    mutate: (d) =>
      writeFileSync(
        join(d, '.adlc', 'config.json'),
        `${JSON.stringify({ acknowledgedNewRailBypass: true, securityMode: 'unsigned-fallback', signers: null })}\n`
      ),
  });
  assert.equal(code, 1);
});

test('legit: a non-rail change with base rails → exit 0', () => {
  const code = runScenario({
    baseTickets: RAILED,
    seedFiles: ['src/critical/auth.mjs', 'src/app.mjs'],
    mutate: (d) => writeFileSync(join(d, 'src/app.mjs'), 'feature\n'),
  });
  assert.equal(code, 0);
});

test('no rails at base → exit 0 (nothing frozen)', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [] }),
    seedFiles: ['src/app.mjs'],
    mutate: (d) => writeFileSync(join(d, 'src/app.mjs'), 'feature\n'),
  });
  assert.equal(code, 0);
});

test('malformed base tickets → exit 1 (fail closed)', () => {
  const code = runScenario({
    baseTickets: '{ not json',
    seedFiles: ['src/app.mjs'],
    mutate: (d) => writeFileSync(join(d, 'src/app.mjs'), 'feature\n'),
  });
  assert.equal(code, 1);
});

test('no .adlc/tickets.json at base → exit 0 (genuinely nothing frozen)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgci-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    writeFileSync(join(dir, 'app.mjs'), 'x\n'); // base has NO .adlc/ at all
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    writeFileSync(join(dir, 'app.mjs'), 'y\n');
    git(dir, ['commit', '-qam', 'change']);
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, 'main'], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      code = e.status ?? 1;
    }
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('base config without tickets still protects config.json trust root → exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgci-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'config.json'), `${VALID_CONFIG}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    writeFileSync(join(dir, '.adlc', 'config.json'), `${JSON.stringify({ ...JSON.parse(VALID_CONFIG), extraField: true })}\n`);
    git(dir, ['commit', '-qam', 'change']);
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, 'main'], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      code = e.status ?? 1;
    }
    assert.equal(code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone bootstrap rejects pre-populated manifest evidence → exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgci-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    writeFileSync(join(dir, 'app.mjs'), 'x\n'); // base has NO .adlc/ at all
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '{"prepopulated":true}\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'change']);
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, 'main'], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      code = e.status ?? 1;
    }
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unresolvable base ref → exit 1 (fail closed, not fail open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgci-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), RAILED);
    writeFileSync(join(dir, 'app.mjs'), 'x\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, 'origin/nonexistent-branch'], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      code = e.status ?? 1;
    }
    assert.equal(code, 1); // bad base must NOT be read as "no rails"
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- T36: rails completion lifecycle — a completed ticket's rails auto-expire ----
// A ticket is "done" iff the BASE manifest carries a trusted completion entry
// (type/gate p5-complete or p6-acceptance-packet) bound to its id. Base-ref only:
// a PR cannot forge it. Fail-closed: no/ambiguous evidence → rails stay frozen.

const T1_RAILED = JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }] });
const editT1Rail = (d) => writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n');

test('T36 AC1: completed ticket (base manifest p5-complete) → its rails auto-expire → exit 0', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, type: 'p5-complete', ticket: 'T1' }) + '\n' },
    mutate: editT1Rail,
  });
  assert.equal(code, 0, 'a done ticket no longer freezes its rails');
});

test('T36 AC1: p6-acceptance-packet also counts as completion → exit 0', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, type: 'p6-acceptance-packet', ticket: 'T1' }) + '\n' },
    mutate: editT1Rail,
  });
  assert.equal(code, 0);
});

test('T36 AC1: completion evidence carried under `gate` (legacy) also counts → exit 0', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, gate: 'p5-complete', ticket: 'T1' }) + '\n' },
    mutate: editT1Rail,
  });
  assert.equal(code, 0);
});

test('T36 AC2: IN-FLIGHT ticket (no completion evidence) still freezes its rails → exit 2', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    seedFiles: ['src/critical/auth.mjs'], // no manifest at all
    mutate: editT1Rail,
  });
  assert.equal(code, 2, 'no evidence → rails remain enforced');
});

test('T36 AC3: forged completion — a status:done ticket field WITHOUT manifest evidence stays frozen → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', status: 'done', done: true, rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: editT1Rail,
  });
  assert.equal(code, 2, 'a self-declared status field is not trusted completion');
});

test('T36 AC3: completion evidence for a DIFFERENT ticket does not lift THIS ticket → exit 2', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, type: 'p5-complete', ticket: 'T2' }) + '\n' },
    mutate: editT1Rail,
  });
  assert.equal(code, 2, 'evidence is keyed by exact ticket id');
});

test('T36 AC3: a NON-completion manifest entry (e.g. spec-lint) does not lift rails → exit 2', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, type: 'spec-lint', ticket: 'T1' }) + '\n' },
    mutate: editT1Rail,
  });
  assert.equal(code, 2, 'only p5-complete/p6-acceptance-packet count');
});

test('T36 AC4: NO self-unfreeze — completion evidence added only at HEAD (not base) does NOT lift → exit 2', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    // base has an EMPTY manifest; the PR appends its own p5-complete entry
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': '' },
    mutate: (d) => {
      writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n');
      // append-only-valid, but only present at HEAD, not base
      writeFileSync(join(d, '.adlc', 'manifest.jsonl'), JSON.stringify({ seq: 1, type: 'p5-complete', ticket: 'T1' }) + '\n');
    },
  });
  assert.equal(code, 2, 'a builder cannot forge completion in their own PR to unfreeze their rails');
});

test('T36 fail-closed: a malformed base manifest line is NOT completion evidence → exit 2', () => {
  const code = runScenario({
    baseTickets: T1_RAILED,
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': 'not json at all\n' },
    mutate: editT1Rail,
  });
  assert.equal(code, 2);
});

test('T36 safety: a path frozen by BOTH a completed and an in-flight ticket STAYS frozen → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [
      { id: 'T1', rails: ['src/critical/**'] },              // completed below
      { id: 'T2', rails: ['src/critical/**', 'src/other/**'] }, // in-flight — still freezes the shared path
    ] }),
    seedFiles: ['src/critical/auth.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, type: 'p5-complete', ticket: 'T1' }) + '\n' },
    mutate: (d) => writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n'),
  });
  assert.equal(code, 2, 'completing T1 must not unfreeze a path T2 still freezes');
});

test('T36 safety: completing T1 lifts ONLY T1-exclusive rails; T2 in-flight rails still enforce → exit 2 on T2 path', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [
      { id: 'T1', rails: ['src/a/**'] }, // completed → src/a lifts
      { id: 'T2', rails: ['src/b/**'] }, // in-flight → src/b frozen
    ] }),
    seedFiles: ['src/a/x.mjs', 'src/b/y.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, type: 'p5-complete', ticket: 'T1' }) + '\n' },
    mutate: (d) => writeFileSync(join(d, 'src', 'b', 'y.mjs'), 'changed\n'), // edits T2's still-frozen rail
  });
  assert.equal(code, 2);
});

test('T36 safety: after completing T1, editing its now-expired rail AND a non-rail file → exit 0', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [
      { id: 'T1', rails: ['src/a/**'] },
      { id: 'T2', rails: ['src/b/**'] },
    ] }),
    seedFiles: ['src/a/x.mjs', 'src/b/y.mjs', '.adlc/manifest.jsonl'],
    seedFileContents: { '.adlc/manifest.jsonl': JSON.stringify({ seq: 1, type: 'p5-complete', ticket: 'T1' }) + '\n' },
    mutate: (d) => { writeFileSync(join(d, 'src', 'a', 'x.mjs'), 'changed\n'); writeFileSync(join(d, 'unrelated.mjs'), 'z\n'); },
  });
  assert.equal(code, 0, 'T1 expired rail is editable; nothing else frozen was touched');
});
