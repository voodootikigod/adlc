// doctor-exit-code.test.mjs — `adlc ticket doctor` must set a real process exit
// code on ok:false (#793). doctorTicketStore's RETURN OBJECT is already covered
// by doctor.test.mjs; this file spawns the REAL bin process and asserts the
// actual exit status, which is the part that was silently always 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectoryTicketStore, applyDirectoryTransaction } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/adlc-tickets.mjs', import.meta.url));

function runDoctor(root, { json = true } = {}) {
  const args = ['doctor', ...(json ? ['--json'] : [])];
  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    status = err.status;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }
  return { status, stdout, stderr };
}

test('doctor bin: a healthy store exits 0 with ok:true (--json)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-exit-'));
  try {
    writeDirectory(root, [ticket('A')]);
    const { status, stdout } = runDoctor(root);
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor bin: a pending unresolved recovery transaction exits 2 with ok:false (--json)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-exit-'));
  try {
    const path = writeDirectory(root, [ticket('A'), ticket('B')]);
    const store = new DirectoryTicketStore(path);
    const before = store.load();
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'Changed A' }), ticket('C')], {
      root,
      expectedSnapshotHash: before.hash,
      faultInjector: (step) => { if (step === 'operation-applied:1') throw new Error('fault:operation-applied:1'); },
    }));
    const { status, stdout } = runDoctor(root);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false, `precondition: doctor result must report ok:false, got:\n${stdout}`);
    assert.equal(status, 2, `a pending unresolved recovery transaction must exit 2, got status ${status}:\n${stdout}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor bin: a stale active-ticket pointer exits 2 with ok:false (--json)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-exit-'));
  try {
    const path = writeDirectory(root, [ticket('A')]);
    const store = new DirectoryTicketStore(path);
    const snapshot = store.load();
    writeFileSync(join(root, '.adlc/current-ticket.json'), JSON.stringify({ id: 'A', ticketHash: 'f'.repeat(64) }));
    const { status, stdout } = runDoctor(root);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false, `precondition: doctor result must report ok:false, got:\n${stdout}`);
    assert.equal(status, 2, `a stale active-ticket pointer must exit 2, got status ${status}:\n${stdout}`);
    void snapshot;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor bin: exit code is set in TEXT mode too, not only --json', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-exit-'));
  try {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const path = writeDirectory(root, [ticket('A')]);
    const store = new DirectoryTicketStore(path);
    writeFileSync(join(root, '.adlc/current-ticket.json'), JSON.stringify({ id: 'A', ticketHash: 'f'.repeat(64) }));
    const { status } = runDoctor(root, { json: false });
    assert.equal(status, 2, 'text-mode doctor on a broken store must also exit 2');
    void store;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor bin: text mode on a healthy store still exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-exit-'));
  try {
    writeDirectory(root, [ticket('A')]);
    const { status } = runDoctor(root, { json: false });
    assert.equal(status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
