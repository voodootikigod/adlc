import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTicketStoreReadOnly, ticketFilename } from '../ticket-readers/read-only-loader.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

test('self-contained harness ticket readers match the canonical generated source', () => {
  const source = readFileSync(join(ROOT, 'scripts/ticket-readers/read-only-loader.mjs'), 'utf8').replace('// GENERATED-LOADER SOURCE.', '// GENERATED FILE — DO NOT EDIT DIRECTLY.');
  for (const output of [
    'plugins/adlc-codex/hooks/generated-ticket-reader.mjs',
    'plugins/adlc-claude-code/hooks/generated-ticket-reader.mjs',
    'plugins/adlc-gemini/generated-ticket-reader.mjs',
  ]) assert.equal(readFileSync(join(ROOT, output), 'utf8'), source, `${output} drifted; run the generator`);
});

test('every shipped glob matcher is the canonical one, byte for byte', () => {
  // The rail matcher used to be hand-ported into eight hooks and one package
  // under "KEEP IN SYNC" comments. That is the arrangement spec §14 forbids, and
  // it is how a fix to core's matcher could leave every INSTALLED harness still
  // running the old one — the copies are what actually enforce rails on a user's
  // machine, since an installed hook has no node_modules to import core from.
  const source = readFileSync(join(ROOT, 'packages/core/lib/glob.mjs'), 'utf8')
    .replace('// GENERATED-GLOB SOURCE.', '// GENERATED FILE — DO NOT EDIT DIRECTLY.');
  for (const output of [
    'plugins/adlc-codex/hooks/generated-glob-match.mjs',
    'plugins/adlc-claude-code/hooks/generated-glob-match.mjs',
    'plugins/adlc-copilot/hooks/generated-glob-match.mjs',
    'plugins/adlc-gemini/generated-glob-match.mjs',
    'packages/tickets/lib/generated-glob-match.mjs',
  ]) assert.equal(readFileSync(join(ROOT, output), 'utf8'), source, `${output} drifted; run the generator`);
});

test('no harness re-implements the glob matcher instead of importing it', () => {
  // Byte-equality above only binds the files that exist. This catches the other
  // direction: a NEW hand-rolled copy, which is how the drift started last time.
  // The old form is recognisable by the regex body it compiled.
  // -F: the needle is the token expansion as it appears in SOURCE, quotes and
  // all. Without it git reads the parentheses as a regex and matches unrelated
  // capture groups.
  // --untracked as well: a new copy arrives as an untracked file first, and a
  // check that only sees the index would pass right up until it was committed.
  const suspects = execFileSync('git', ['grep', '--untracked', '-lF', "'(?:.*/)?'", '--', '*.mjs'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024,
  }).split('\n').filter(Boolean);
  const allowed = new Set([
    'packages/core/test/core.test.mjs',                // the reference implementation, deliberately kept
    'scripts/test/ticket-reader-generation.test.mjs',  // this file, which names the needle
  ]);
  const rogue = suspects.filter((f) => !allowed.has(f));
  assert.deepEqual(rogue, [], `hand-rolled glob matchers found; import the generated copy instead: ${rogue.join(', ')}`);
});

test('every shipped glob matcher answers a repeated-globstar rail in bounded time', async () => {
  // Byte-equality says the copies are identical; this says what they are
  // identical TO still holds the property the copies exist for. It is the
  // installed hooks that enforce rails on a user's machine, and the regex form
  // they used to carry did not finish this input in ten minutes.
  const pattern = `a/${'**/'.repeat(200)}z`;
  const path = `a/${Array.from({ length: 2000 }, (_, i) => `s${i}`).join('/')}/x.mjs`;
  for (const copy of [
    'packages/core/lib/glob.mjs',
    'plugins/adlc-codex/hooks/generated-glob-match.mjs',
    'plugins/adlc-claude-code/hooks/generated-glob-match.mjs',
    'plugins/adlc-copilot/hooks/generated-glob-match.mjs',
    'plugins/adlc-gemini/generated-glob-match.mjs',
    'packages/tickets/lib/generated-glob-match.mjs',
  ]) {
    const { globMatch } = await import(join(ROOT, copy));
    const started = process.hrtime.bigint();
    assert.equal(globMatch(pattern, path), false, copy);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 2000, `${copy} took ${elapsedMs | 0}ms`);
  }
});

test('generated-loader source reads equivalent legacy and sharded snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-generated-reader-'));
  try {
    const ticket = { id: 'T1', title: 'Reader fixture', rails: ['test/**'] };
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const legacy = loadTicketStoreReadOnly({ root, env: {} });
    rmSync(join(root, '.adlc/tickets.json'));
    mkdirSync(join(root, '.adlc/tickets'));
    writeFileSync(join(root, '.adlc/tickets/.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(root, '.adlc/tickets', ticketFilename(ticket.id)), JSON.stringify(ticket));
    const directory = loadTicketStoreReadOnly({ root, env: {} });
    assert.equal(directory.hash, legacy.hash);
    assert.equal(directory.ticketHashes.T1, legacy.ticketHashes.T1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generated-loader rejects symlinked stores and symlinked store parents', () => {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-generated-reader-symlink-'));
  try {
    const ticket = { id: 'T1', title: 'Reader fixture' };
    const outsideLegacy = join(parent, 'outside-tickets.json');
    writeFileSync(outsideLegacy, JSON.stringify({ tickets: [ticket] }));
    const legacyRoot = join(parent, 'legacy-repo');
    mkdirSync(join(legacyRoot, '.adlc'), { recursive: true });
    symlinkSync(outsideLegacy, join(legacyRoot, '.adlc/tickets.json'));
    assert.throws(() => loadTicketStoreReadOnly({ root: legacyRoot, env: {} }), /non-symlink file/);

    const outsideAdlc = join(parent, 'outside-adlc');
    mkdirSync(join(outsideAdlc, 'tickets'), { recursive: true });
    writeFileSync(join(outsideAdlc, 'tickets/.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(outsideAdlc, 'tickets', ticketFilename(ticket.id)), JSON.stringify(ticket));
    const directoryRoot = join(parent, 'directory-repo');
    mkdirSync(directoryRoot);
    symlinkSync(outsideAdlc, join(directoryRoot, '.adlc'), 'dir');
    assert.throws(() => loadTicketStoreReadOnly({ root: directoryRoot, env: {} }), /non-symlink directory/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
