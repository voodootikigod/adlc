import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, LegacyTicketStore, ticketFilename } from '../index.mjs';
import { ticket, writeDirectory, writeLegacy } from './helpers.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'adlc-tickets-directory-'));

test('directory and legacy stores produce the same immutable logical snapshot', () => {
  const dir = root();
  try {
    const tickets = [ticket('B', { unknown: { z: 1, a: [2, 1] } }), ticket('A')];
    writeLegacy(dir, tickets);
    const legacy = new LegacyTicketStore(join(dir, '.adlc/tickets.json')).load();
    rmSync(join(dir, '.adlc/tickets.json'));
    const path = writeDirectory(dir, tickets.reverse());
    const sharded = new DirectoryTicketStore(path).load();
    assert.equal(sharded.hash, legacy.hash);
    assert.deepEqual(sharded.tickets.map((item) => item.id), ['A', 'B']);
    assert.throws(() => { sharded.tickets[0].title = 'mutated'; }, TypeError);
    assert.throws(() => { sharded.tickets[1].unknown.a.push(3); }, TypeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('closed layout rejects extra files, nested directories, symlinks, filename mismatch, dangling edges, and cycles', () => {
  const cases = [
    (path) => writeFileSync(join(path, 'README'), 'no'),
    (path) => mkdirSync(join(path, 'nested')),
    (path) => symlinkSync(join(path, '.store.json'), join(path, 'alias.json')),
    (path) => writeFileSync(join(path, ticketFilename('X')), JSON.stringify(ticket('Y'))),
    (path) => writeFileSync(join(path, ticketFilename('X')), JSON.stringify(ticket('X', { edges: [{ to: 'Y' }] }))),
    (path) => {
      writeFileSync(join(path, ticketFilename('X')), JSON.stringify(ticket('X', { edges: [{ to: 'Y' }] })));
      writeFileSync(join(path, ticketFilename('Y')), JSON.stringify(ticket('Y', { edges: [{ to: 'X' }] })));
    },
  ];
  for (const poison of cases) {
    const dir = root();
    try {
      const path = writeDirectory(dir, []);
      poison(path);
      assert.throws(() => new DirectoryTicketStore(path).load());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('store roots and legacy files cannot be symlinks', () => {
  const dir = root();
  try {
    const realDirectory = writeDirectory(dir, [ticket('A')]);
    const aliasDirectory = join(dir, 'tickets-alias');
    symlinkSync(realDirectory, aliasDirectory, 'dir');
    assert.throws(() => new DirectoryTicketStore(aliasDirectory).load(), (error) => error.code === 'UNSAFE_STORE_PATH');

    writeLegacy(dir, [ticket('A')]);
    const legacyPath = join(dir, '.adlc/tickets.json');
    const realLegacy = join(dir, 'tickets-real.json');
    rmSync(realLegacy, { force: true });
    writeFileSync(realLegacy, JSON.stringify({ tickets: [ticket('A')] }));
    rmSync(legacyPath);
    symlinkSync(realLegacy, legacyPath);
    assert.throws(() => new LegacyTicketStore(legacyPath).load(), (error) => error.code === 'UNSAFE_STORE_PATH');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a symlinked store parent cannot redirect active storage outside the repository', () => {
  const dir = root();
  const external = root();
  try {
    const externalAdlc = join(external, '.adlc');
    mkdirSync(externalAdlc, { recursive: true });
    writeFileSync(join(externalAdlc, 'tickets.json'), JSON.stringify({ tickets: [ticket('A')] }));
    writeDirectory(external, [ticket('A')]);
    symlinkSync(externalAdlc, join(dir, '.adlc'), 'dir');
    assert.throws(() => new LegacyTicketStore(join(dir, '.adlc/tickets.json')).load(), (error) => error.code === 'UNSAFE_STORE_PATH');
    assert.throws(() => new DirectoryTicketStore(join(dir, '.adlc/tickets')).load(), (error) => error.code === 'UNSAFE_STORE_PATH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
