// Subprocess tests for bin/show-ticket.mjs — the split-pane ticket renderer.
// A stub `adlc` is placed at the front of PATH so the render path runs for
// real without the toolkit; argv misparses and the usage guard are pinned.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'show-ticket.mjs');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-show-'));
  const stub = join(dir, 'adlc');
  writeFileSync(stub, '#!/bin/sh\necho "STUB TICKET $3 \x1b[31mhostile\x1b[0m"\n');
  chmodSync(stub, 0o755);
  mkdirSync(join(dir, 'repo'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8',
  timeout: 10_000,
  input: '\n', // the trailing "press Enter" read
  env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
});

test('renders the ticket via the adlc CLI, sanitized, with the close prompt', () => {
  const res = run([join(dir, 'repo'), 't-x1']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('STUB TICKET t-x1'));
  assert.ok(!res.stdout.includes('\x1b'), 'escapes must be stripped');
  assert.ok(res.stdout.includes('press Enter to close'));
});

test('exits with the usage error when repoRoot or ticketId is missing', () => {
  assert.equal(run([]).status, 1);
  assert.equal(run([join(dir, 'repo')]).status, 1);
});

test('refuses a hostile ticket id instead of passing it to the CLI', () => {
  const res = run([join(dir, 'repo'), 't-x1;rm -rf /']);
  assert.equal(res.status, 1);
});
