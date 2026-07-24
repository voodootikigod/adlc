// rails-guard-ci.test.mjs — the CI rail-freeze backstop is the unbypassable
// commit-time gate, so it gets a committed regression test. Builds throwaway git
// repos and drives the real script. Offline, leaves no trace.
//
// The load-bearing property: the rail set is read from the TRUSTED BASE ref, so a
// PR that removes rails (or edits the ticket trust root) while touching a frozen
// path is still rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ACTIVE_MANIFEST, ARCHIVE_MANIFEST, prettyCanonicalJson, sha256, storeHash, ticketFilename } from '@adlc/tickets';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'rails-guard-ci.mjs');

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/**
 * Build a repo whose base (main) has `baseTickets` and a file at each
 * `seedFiles` path, then apply `mutate(dir)` on a feature branch. Returns the
 * script's exit code when run with base=main.
 */
function runScenario({ baseTickets, seedFiles, mutate, seedFileContents = {}, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'rgci-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    try {
      const parsedBaseTickets = JSON.parse(baseTickets);
      for (const ticket of parsedBaseTickets.tickets ?? []) ticket.title ??= `${ticket.id} fixture`;
      writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(parsedBaseTickets));
    } catch {
      writeFileSync(join(dir, '.adlc', 'tickets.json'), baseTickets);
    }
    for (const f of seedFiles) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      writeFileSync(join(dir, f), seedFileContents[f] ?? 'orig\n');
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['checkout', '-q', '-b', 'feat']);
    mutate(dir);
    try {
      const headPath = join(dir, '.adlc', 'tickets.json');
      const parsedHeadTickets = JSON.parse(readFileSync(headPath, 'utf8'));
      for (const ticket of parsedHeadTickets.tickets ?? []) ticket.title ??= `${ticket.id} fixture`;
      writeFileSync(headPath, JSON.stringify(parsedHeadTickets));
    } catch {
      // Malformed/missing ticket-store attack fixtures must remain malformed.
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'change']);
    try {
      execFileSync(process.execPath, [SCRIPT, 'main'], { cwd: dir, stdio: 'pipe', env: { ...process.env, ...env } });
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

function runMigrationScenario({ mutateTicket = (ticket) => ticket, extraChange = false, evidence = 'valid', legacyArchive = false, injectArchive = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rgci-migrate-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const ticket = { id: 'T1', title: 'Migration fixture', rails: ['src/critical/**'] };
    writeFileSync(join(dir, '.adlc/tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const archived = { id: 'OLD', title: 'Archived migration fixture', completed: true };
    if (legacyArchive) writeFileSync(join(dir, '.adlc/tickets.archive.json'), JSON.stringify({ tickets: [archived] }));
    writeFileSync(join(dir, '.gitignore'), '.adlc/*\n!.adlc/tickets.json\n');
    git(dir, ['add', '-A']);
    if (legacyArchive) git(dir, ['add', '-f', '.adlc/tickets.archive.json']);
    git(dir, ['commit', '-qm', 'base']); git(dir, ['checkout', '-q', '-b', 'feat']);
    rmSync(join(dir, '.adlc/tickets.json'));
    mkdirSync(join(dir, '.adlc/tickets'), { recursive: true });
    mkdirSync(join(dir, '.adlc/ticket-archive'), { recursive: true });
    const next = mutateTicket(structuredClone(ticket));
    writeFileSync(join(dir, '.adlc/tickets/.store.json'), prettyCanonicalJson(ACTIVE_MANIFEST));
    writeFileSync(join(dir, '.adlc/tickets', ticketFilename(next.id)), prettyCanonicalJson(next));
    writeFileSync(join(dir, '.adlc/ticket-archive/.store.json'), prettyCanonicalJson(ARCHIVE_MANIFEST));
    if (legacyArchive) {
      rmSync(join(dir, '.adlc/tickets.archive.json'));
      writeFileSync(join(dir, '.adlc/ticket-archive', ticketFilename(archived.id)), prettyCanonicalJson(archived));
    }
    const injected = { id: 'INJECTED', title: 'Not present in the trusted base', completed: true };
    if (injectArchive) writeFileSync(join(dir, '.adlc/ticket-archive', ticketFilename(injected.id)), prettyCanonicalJson(injected));
    if (evidence !== 'missing') {
      const hash = ['valid', 'recovered'].includes(evidence) ? storeHash([next]) : '0'.repeat(64);
      const apply = {
        seq: 1,
        gate: 'ticket-migrate',
        ts: '2026-07-13T00:00:00.000Z',
        data: { operation: 'migrate', action: 'apply', transactionId: 'fixture-transaction', revision: null, ticketHash: null, storeHash: hash, archiveHash: storeHash(legacyArchive ? [archived] : injectArchive ? [injected] : []), bindingScope: 'store' },
        files: {},
        prev: null,
      };
      const entries = [apply];
      if (evidence === 'recovered') entries.push({
        seq: 2,
        gate: 'ticket-migrate',
        ts: '2026-07-13T00:01:00.000Z',
        data: { ...apply.data, action: 'recover-complete' },
        files: {},
        prev: sha256(JSON.stringify(apply)),
      });
      writeFileSync(join(dir, '.adlc/manifest.jsonl'), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    }
    writeFileSync(join(dir, '.gitignore'), '.adlc/*\n!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n');
    if (extraChange) { mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src/extra.mjs'), 'export {};\n'); }
    git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'migrate']);
    try { execFileSync(process.execPath, [SCRIPT, 'main'], { cwd: dir, stdio: 'pipe' }); return 0; }
    catch (error) { return error.status ?? 1; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('legacy-to-directory migration with identical logical content is accepted', () => {
  assert.equal(runMigrationScenario(), 0);
  assert.equal(runMigrationScenario({ evidence: 'recovered' }), 0);
});

test('legacy-to-directory migration that changes ticket content is denied', () => {
  assert.equal(runMigrationScenario({ mutateTicket: (ticket) => ({ ...ticket, title: 'Changed' }) }), 2);
});

test('legacy-to-directory migration mixed with unrelated changes is denied', () => {
  assert.equal(runMigrationScenario({ extraChange: true }), 2);
});

test('legacy-to-directory migration requires hash-bound evidence', () => {
  assert.equal(runMigrationScenario({ evidence: 'missing' }), 2);
  assert.equal(runMigrationScenario({ evidence: 'invalid' }), 2);
});

test('legacy archive migration is accepted only with identical archived content', () => {
  assert.equal(runMigrationScenario({ legacyArchive: true }), 0);
  assert.equal(runMigrationScenario({ injectArchive: true }), 2);
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
// TRUST ANCHOR: `completed: true` on the ticket in the BASE tickets.json. It is
// admin-ceremony-only because assertBaseTicketContractsPreserved DENIES a PR
// that adds/changes a field on an existing base ticket, and it is read from
// base (never HEAD). The manifest is NOT trusted (the gate can't verify it).

const editT1Rail = (d) => writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n');

test('T36 AC1: completed:true on a base ticket → its rails auto-expire → exit 0', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', completed: true, rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: editT1Rail,
  });
  assert.equal(code, 0, 'a done ticket no longer freezes its rails');
});

test('T36 AC1: completed must be a STRICT boolean true — "true"/1/truthy do NOT lift → exit 2', () => {
  for (const val of ['true', 1, 'yes', {}]) {
    const code = runScenario({
      baseTickets: JSON.stringify({ tickets: [{ id: 'T1', completed: val, rails: ['src/critical/**'] }] }),
      seedFiles: ['src/critical/auth.mjs'],
      mutate: editT1Rail,
    });
    assert.equal(code, 2, `completed:${JSON.stringify(val)} must not lift (fail closed)`);
  }
});

test('T36 AC2: an IN-FLIGHT ticket (no completed field) still freezes its rails → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: editT1Rail,
  });
  assert.equal(code, 2);
});

test('T36 AC3 forge resistance: a PR that ADDS completed:true to an existing base ticket is DENIED → exit 2', () => {
  // base has T1 WITHOUT completed; the PR tries to mark it complete to unfreeze it.
  // assertBaseTicketContractsPreserved denies any change to an existing base ticket.
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => {
      writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n');
      writeFileSync(join(d, '.adlc', 'tickets.json'),
        JSON.stringify({ tickets: [{ id: 'T1', completed: true, rails: ['src/critical/**'] }] }));
    },
  });
  assert.equal(code, 2, 'a non-admin cannot forge completion on an existing ticket');
});

test('T36 AC4 no self-unfreeze: even marking it complete AND removing its rail in the PR is DENIED → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => {
      writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n');
      writeFileSync(join(d, '.adlc', 'tickets.json'),
        JSON.stringify({ tickets: [{ id: 'T1', completed: true, rails: [] }] }));
    },
  });
  assert.equal(code, 2, 'contract preservation blocks the self-serve completion+unfreeze');
});

test('T36 AC4: a NEW ticket a PR authors with completed:true cannot unfreeze ANOTHER ticket’s rails → exit 2', () => {
  // A PR may add new tickets. An attacker adds T99 completed:true — but that only
  // skips T99's own (empty) rails; T1 (in-flight) still freezes src/critical.
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => {
      writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n');
      writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [
        { id: 'T1', rails: ['src/critical/**'] },
        { id: 'T99', completed: true, rails: ['src/critical/**'] }, // attacker's new "completed" ticket
      ] }));
    },
  });
  assert.equal(code, 2, 'a completed NEW ticket cannot lift a still-in-flight ticket’s rails');
});

test('T36 safety: a path frozen by BOTH a completed and an in-flight ticket STAYS frozen → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [
      { id: 'T1', completed: true, rails: ['src/critical/**'] },
      { id: 'T2', rails: ['src/critical/**', 'src/other/**'] }, // in-flight — still freezes the shared path
    ] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: editT1Rail,
  });
  assert.equal(code, 2, 'completing T1 must not unfreeze a path T2 still freezes');
});

test('T36 safety: completing T1 lifts ONLY T1-exclusive rails; T2 in-flight rails still enforce → exit 2 on T2 path', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [
      { id: 'T1', completed: true, rails: ['src/a/**'] },
      { id: 'T2', rails: ['src/b/**'] },
    ] }),
    seedFiles: ['src/a/x.mjs', 'src/b/y.mjs'],
    mutate: (d) => writeFileSync(join(d, 'src', 'b', 'y.mjs'), 'changed\n'),
  });
  assert.equal(code, 2);
});

test('T36 safety: after completing T1, editing its now-expired rail AND a non-rail file → exit 0', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [
      { id: 'T1', completed: true, rails: ['src/a/**'] },
      { id: 'T2', rails: ['src/b/**'] },
    ] }),
    seedFiles: ['src/a/x.mjs', 'src/b/y.mjs'],
    mutate: (d) => { writeFileSync(join(d, 'src', 'a', 'x.mjs'), 'changed\n'); writeFileSync(join(d, 'unrelated.mjs'), 'z\n'); },
  });
  assert.equal(code, 0, 'T1 expired rail is editable; nothing else frozen was touched');
});

// ---- T36 guardrails (codex round-1 review) ----

test('T36 guardrail #1: a completed ticket is STILL contract-preserved — a PR editing it is DENIED → exit 2', () => {
  // Completing a ticket expires its RAILS only; its contract stays immutable, so
  // a PR cannot mutate/delete a completed base ticket.
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', completed: true, rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', completed: true, rails: ['src/critical/**'], injected: 'x' }] })),
  });
  assert.equal(code, 2, 'a completed ticket contract is still frozen');
});

test('T36 guardrail #1: a PR that REMOVES a completed base ticket is DENIED → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [
      { id: 'T1', completed: true, rails: ['src/critical/**'] },
      { id: 'T2', rails: ['src/other/**'] },
    ] }),
    seedFiles: ['src/critical/auth.mjs', 'src/other/x.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T2', rails: ['src/other/**'] }] })), // T1 dropped
  });
  assert.equal(code, 2, 'a completed base ticket cannot be removed');
});

test('T36 guardrail #5: an ALL-COMPLETED repo (rails empty) still protects trust roots via baseHasConfig → exit 2', () => {
  // Every ticket completed → rails union is empty. Trust-root protection must
  // still run (it keys on baseHasConfig, independent of the rail union).
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', completed: true, rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs', '.adlc/config.json'],
    seedFileContents: { '.adlc/config.json': JSON.stringify({ securityMode: 'unsigned-fallback', acknowledgedNewRailBypass: true, trustedCodeownersAttested: true }) },
    mutate: (d) => writeFileSync(join(d, '.adlc', 'config.json'),
      JSON.stringify({ securityMode: 'unsigned-fallback', acknowledgedNewRailBypass: true, trustedCodeownersAttested: true, tampered: true })),
  });
  assert.equal(code, 2, 'trust roots stay protected even when all rails have expired');
});

test('T36 guardrail #5: all-completed repo, editing a now-expired rail path → exit 0 (rails genuinely lifted)', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', completed: true, rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => writeFileSync(join(d, 'src', 'critical', 'auth.mjs'), 'changed\n'),
  });
  assert.equal(code, 0);
});

// ---- #104: ticket-prune tombstone — the gate accepts a `completed:true` annotation
// on a RAILS-LESS base ticket (zero unfreeze privilege), but nothing more. ----

test('#104: a PR adding ONLY completed:true to a rails-LESS base ticket is ALLOWED → exit 0', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [], title: 'done work' }] }),
    seedFiles: ['app.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', rails: [], title: 'done work', completed: true }] })),
  });
  assert.equal(code, 0, 'tombstoning a shipped rails-less ticket merges via a normal PR');
});

test('#104 forge resistance: adding completed:true to a RAILED base ticket is STILL DENIED → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'] }] }),
    seedFiles: ['src/critical/auth.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/critical/**'], completed: true }] })),
  });
  assert.equal(code, 2, 'completing a still-railed ticket needs the admin ceremony (would unfreeze)');
});

test('#104: completed:true + ANY other field change on a rails-less ticket → DENIED → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [], title: 'orig' }] }),
    seedFiles: ['app.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', rails: [], title: 'TAMPERED', completed: true }] })),
  });
  assert.equal(code, 2, 'only the completed annotation may be added, nothing else');
});

test('#104: adding completed:true AND rails in the same PR → DENIED → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
    seedFiles: ['app.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', rails: ['src/x/**'], completed: true }] })),
  });
  assert.equal(code, 2, 'cannot smuggle a rails change under the completion annotation');
});

test('#104: completed must be STRICT true — "true"/1/false do NOT get the annotation exemption → exit 2', () => {
  for (const val of ['true', 1, false]) {
    const code = runScenario({
      baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }] }),
      seedFiles: ['app.mjs'],
      mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
        JSON.stringify({ tickets: [{ id: 'T1', rails: [], completed: val }] })),
    });
    assert.equal(code, 2, `completed:${JSON.stringify(val)} is not the exempt annotation`);
  }
});

test('#104: base ticket that ALREADY has a completed field cannot be re-annotated (only pristine → completed) → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [], completed: false }] }),
    seedFiles: ['app.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', rails: [], completed: true }] })),
  });
  assert.equal(code, 2, 'the exemption is add-only on a ticket with no completed field');
});

test('#104: REMOVING a rails-less base ticket is still DENIED (tombstone, never delete) → exit 2', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [] }, { id: 'T2', rails: [] }] }),
    seedFiles: ['app.mjs'],
    mutate: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T2', rails: [] }] })),
  });
  assert.equal(code, 2, 'removal still needs the ceremony');
});

test('#104: idempotent — a PR that leaves an already-completed base ticket unchanged → exit 0', () => {
  const code = runScenario({
    baseTickets: JSON.stringify({ tickets: [{ id: 'T1', rails: [], completed: true }] }),
    seedFiles: ['app.mjs'],
    mutate: (d) => writeFileSync(join(d, 'app.mjs'), 'changed\n'),
  });
  assert.equal(code, 0);
});

// ---- #141: trust-root change ceremony (authorized-path recognition) ----

function writeEvent(author, labels, number = 7) {
  const p = join(mkdtempSync(join(tmpdir(), 'rgci-event-')), 'event.json');
  writeFileSync(p, JSON.stringify({
    pull_request: { number, user: { login: author }, labels: labels.map((name) => ({ name })) },
  }));
  return p;
}

// A PR that changes a trust root (docs/ci/rails-guard.yml), with config present
// so immutableTrustRoots is active. CODEOWNERS at base owns the changed path.
const trustRootChange = (env) => runScenario({
  baseTickets: '{"tickets":[]}',
  seedFiles: ['.adlc/config.json', '.adlc/manifest.jsonl', 'CODEOWNERS', 'docs/ci/rails-guard.yml'],
  seedFileContents: {
    '.adlc/config.json': VALID_CONFIG,
    '.adlc/manifest.jsonl': '',
    CODEOWNERS: '/docs/ci/rails-guard.yml   @trusty\n',
    'docs/ci/rails-guard.yml': 'orig\n',
  },
  mutate: (dir) => writeFileSync(join(dir, 'docs/ci/rails-guard.yml'), 'changed\n'),
  env,
});

test('#141: a trust-root change with no PR context is denied (exit 2)', () => {
  assert.equal(trustRootChange({}), 2);
});

test('#141: label + non-author CODEOWNER approval AUTHORIZES the change (exit 0)', () => {
  assert.equal(trustRootChange({
    GITHUB_EVENT_PATH: writeEvent('contributor', ['trust-root-change']),
    ADLC_PR_REVIEWS: JSON.stringify([{ user: { login: 'trusty' }, state: 'APPROVED' }]),
  }), 0);
});

test('#141: author self-approval does NOT authorize (exit 2)', () => {
  assert.equal(trustRootChange({
    GITHUB_EVENT_PATH: writeEvent('trusty', ['trust-root-change']), // author is the owner
    ADLC_PR_REVIEWS: JSON.stringify([{ user: { login: 'trusty' }, state: 'APPROVED' }]),
  }), 2);
});

test('#141: approval from a non-CODEOWNER is not enough (exit 2)', () => {
  assert.equal(trustRootChange({
    GITHUB_EVENT_PATH: writeEvent('contributor', ['trust-root-change']),
    ADLC_PR_REVIEWS: JSON.stringify([{ user: { login: 'random' }, state: 'APPROVED' }]),
  }), 2);
});

test('#141: missing the label denies even with a CODEOWNER approval (exit 2)', () => {
  assert.equal(trustRootChange({
    GITHUB_EVENT_PATH: writeEvent('contributor', []),
    ADLC_PR_REVIEWS: JSON.stringify([{ user: { login: 'trusty' }, state: 'APPROVED' }]),
  }), 2);
});

// #141 P5: the authorized-path lift must NOT over-lift a frozen ticket rail, and
// a trust-root RENAME must be authorizable (both old+new paths handled).
const RAILED_TRUST_ROOT_FILES = ['.adlc/config.json', '.adlc/manifest.jsonl', 'CODEOWNERS', 'docs/ci/rails-guard.yml', 'src/critical/auth.mjs'];
const RAILED_TRUST_ROOT_CONTENTS = {
  '.adlc/config.json': VALID_CONFIG,
  '.adlc/manifest.jsonl': '',
  CODEOWNERS: '/docs/ci/rails-guard.yml   @trusty\n',
  'docs/ci/rails-guard.yml': 'orig\n',
  'src/critical/auth.mjs': 'orig\n',
};
const authorizedEnv = () => ({
  GITHUB_EVENT_PATH: writeEvent('contributor', ['trust-root-change']),
  ADLC_PR_REVIEWS: JSON.stringify([{ user: { login: 'trusty' }, state: 'APPROVED' }]),
});

test('#141: an authorized trust-root change does NOT lift an unrelated frozen ticket rail', () => {
  const status = runScenario({
    baseTickets: '{"tickets":[{"id":"T1","rails":["src/critical/**"]}]}',
    seedFiles: RAILED_TRUST_ROOT_FILES,
    seedFileContents: RAILED_TRUST_ROOT_CONTENTS,
    mutate: (dir) => {
      writeFileSync(join(dir, 'docs/ci/rails-guard.yml'), 'changed\n'); // authorized trust root
      writeFileSync(join(dir, 'src/critical/auth.mjs'), 'sneak\n');     // out-of-scope ticket rail
    },
    env: authorizedEnv(),
  });
  assert.equal(status, 2); // the frozen ticket rail edit is STILL denied
});

test('#141: the same authorized trust-root change alone (no ticket-rail edit) is allowed', () => {
  const status = runScenario({
    baseTickets: '{"tickets":[{"id":"T1","rails":["src/critical/**"]}]}',
    seedFiles: RAILED_TRUST_ROOT_FILES,
    seedFileContents: RAILED_TRUST_ROOT_CONTENTS,
    mutate: (dir) => writeFileSync(join(dir, 'docs/ci/rails-guard.yml'), 'changed\n'),
    env: authorizedEnv(),
  });
  assert.equal(status, 0);
});

test('#141: label present but the reviews payload is absent → clean deny, not a crash (exit 2)', () => {
  // GITHUB_EVENT_PATH is set (real PR context, label applied) but ADLC_PR_REVIEWS
  // is UNSET — the reviews fetch yielded nothing. readPrContext must treat that as
  // "no approving review" and fall through to deny, NOT dereference undefined. This
  // pins the `rawReviews && rawReviews.trim()` guard: swapping it to `||` makes
  // `undefined || undefined.trim()` throw, and the trust-root block is not wrapped
  // in a try/catch, so the throw would surface as exit 1 (crash) instead of 2.
  assert.equal(trustRootChange({
    GITHUB_EVENT_PATH: writeEvent('contributor', ['trust-root-change']),
    // ADLC_PR_REVIEWS intentionally omitted
  }), 2);
});

test('#141: CODEOWNERS discovered only at docs/CODEOWNERS still resolves owners (authorized, exit 0)', () => {
  // The owner of the changed trust root is declared ONLY in the third search
  // location, docs/CODEOWNERS. codeownersOwnersFor must probe all three locations;
  // dropping docs/CODEOWNERS from the search list would leave owners empty and
  // deny an otherwise-authorized change. This pins that third location.
  const status = runScenario({
    baseTickets: '{"tickets":[]}',
    seedFiles: ['.adlc/config.json', '.adlc/manifest.jsonl', 'docs/CODEOWNERS', 'docs/ci/rails-guard.yml'],
    seedFileContents: {
      '.adlc/config.json': VALID_CONFIG,
      '.adlc/manifest.jsonl': '',
      'docs/CODEOWNERS': '/docs/ci/rails-guard.yml   @trusty\n',
      'docs/ci/rails-guard.yml': 'orig\n',
    },
    mutate: (dir) => writeFileSync(join(dir, 'docs/ci/rails-guard.yml'), 'changed\n'),
    env: authorizedEnv(),
  });
  assert.equal(status, 0);
});

test('#141: an authorized trust-root RENAME between two trust roots is allowed (both path columns handled)', () => {
  // CODEOWNERS -> .github/CODEOWNERS: BOTH are in immutableTrustRoots, so git
  // emits a real `R100\told\tnew` row (a rename to a NON-trust-root dest would be
  // pruned to a lone deletion by the pathspec and never exercise the capture).
  // Base CODEOWNERS owns ONLY the OLD path, so the pre-fix (new-path-only) code
  // finds no owner and denies; the fixed two-column capture resolves the OLD
  // path's owner and authorizes — this test is RED without the fix.
  const content = '/CODEOWNERS   @trusty\n';
  const status = runScenario({
    baseTickets: '{"tickets":[]}',
    seedFiles: ['.adlc/config.json', '.adlc/manifest.jsonl', 'CODEOWNERS'],
    seedFileContents: {
      '.adlc/config.json': VALID_CONFIG,
      '.adlc/manifest.jsonl': '',
      CODEOWNERS: content,
    },
    mutate: (dir) => {
      rmSync(join(dir, 'CODEOWNERS'));
      mkdirSync(join(dir, '.github'), { recursive: true });
      writeFileSync(join(dir, '.github/CODEOWNERS'), content);
    },
    env: authorizedEnv(),
  });
  assert.equal(status, 0);
});
