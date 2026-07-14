import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketFilename } from '../generated-ticket-reader.mjs';

const hook = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-rails-guard.mjs');

test('Codex self-contained hook reads a sharded store and freezes shard paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-shards-'));
  try {
    const store = join(root, '.adlc/tickets');
    mkdirSync(store, { recursive: true });
    const ticket = { id: 'T1', title: 'Codex shard fixture', rails: ['test/**'] };
    const shard = ticketFilename(ticket.id);
    writeFileSync(join(store, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(store, shard), JSON.stringify(ticket));
    const run = (path) => {
      try {
        execFileSync(process.execPath, [hook], {
          cwd: root,
          input: JSON.stringify({ tool_name: 'apply_patch', input: { path } }),
          encoding: 'utf8',
          env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
        });
        return 0;
      } catch (error) { return error.status; }
    };
    assert.equal(run('test/x.mjs'), 2);
    assert.equal(run(`.adlc/tickets/${shard}`), 2);
    assert.equal(run('src/x.mjs'), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
