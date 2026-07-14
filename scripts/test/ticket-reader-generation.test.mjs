import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTicketStoreReadOnly, ticketFilename } from '../ticket-readers/read-only-loader.mjs';

test('self-contained harness ticket readers match the canonical generated source', () => {
  const source = readFileSync('scripts/ticket-readers/read-only-loader.mjs', 'utf8').replace('// GENERATED-LOADER SOURCE.', '// GENERATED FILE — DO NOT EDIT DIRECTLY.');
  for (const output of [
    'plugins/adlc-codex/hooks/generated-ticket-reader.mjs',
    'plugins/adlc-claude-code/hooks/generated-ticket-reader.mjs',
    'plugins/adlc-antigravity/generated-ticket-reader.mjs',
  ]) assert.equal(readFileSync(join(output), 'utf8'), source, `${output} drifted; run the generator`);
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
