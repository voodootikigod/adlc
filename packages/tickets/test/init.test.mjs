import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_DIRECTORY,
  ACTIVE_MANIFEST,
  canonicalJson,
  detectTicketStore,
  initializeDirectoryStore,
  initializeTicketStores,
} from '../index.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-store-init-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('initializeDirectoryStore creates a detectable, empty store with the canonical manifest', () => {
  fixture((root) => {
    const path = join(root, ACTIVE_DIRECTORY);
    initializeDirectoryStore(path);
    const manifest = JSON.parse(readFileSync(join(path, '.store.json'), 'utf8'));
    assert.equal(canonicalJson(manifest), canonicalJson(ACTIVE_MANIFEST));
    const store = detectTicketStore({ root });
    assert.equal(store.load().tickets.length, 0);
  });
});

test('initializeDirectoryStore refuses to clobber an existing store', () => {
  fixture((root) => {
    const path = join(root, ACTIVE_DIRECTORY);
    initializeDirectoryStore(path);
    assert.throws(() => initializeDirectoryStore(path), (error) => error.code === 'STORE_EXISTS');
  });
});

test('initializeTicketStores is a no-op that preserves an existing legacy store', () => {
  fixture((root) => {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ version: 1, tickets: [] }));
    const result = initializeTicketStores(root);
    assert.equal(result.backend, 'legacy');
    assert.equal(result.created, false);
    assert.equal(existsSync(join(root, ACTIVE_DIRECTORY)), false);
  });
});

test('initializeTicketStores refuses an ambiguous dual store', () => {
  fixture((root) => {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ version: 1, tickets: [] }));
    initializeDirectoryStore(join(root, ACTIVE_DIRECTORY));
    assert.throws(() => initializeTicketStores(root), (error) => error.code === 'AMBIGUOUS_STORE');
  });
});
