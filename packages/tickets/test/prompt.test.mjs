import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegacyTicketStore, offerLegacyMigration, shouldOfferLegacyMigration } from '../index.mjs';

const legacy = new LegacyTicketStore('/unused/.adlc/tickets.json');
const tty = { isTTY: true, write() {} };
const pipe = { isTTY: false, write() {} };

test('legacy migration is offered only to interactive non-JSON writers', () => {
  assert.equal(shouldOfferLegacyMigration(legacy, {}, { input: tty, output: tty }), true);
  assert.equal(shouldOfferLegacyMigration(legacy, { json: true }, { input: tty, output: tty }), false);
  assert.equal(shouldOfferLegacyMigration(legacy, {}, { input: pipe, output: tty }), false);
  assert.equal(shouldOfferLegacyMigration(legacy, {}, { input: tty, output: pipe }), false);
});

test('default or explicit decline leaves the legacy backend untouched', async () => {
  let migrations = 0;
  let detections = 0;
  for (const answer of ['', 'n', 'no']) {
    const result = await offerLegacyMigration(legacy, '/unused', {}, {
      input: tty,
      output: tty,
      emit() {},
      ask: async () => answer,
      plan: () => ({ operation: 'migrate' }),
      migrate: () => { migrations += 1; },
      detect: () => { detections += 1; },
    });
    assert.equal(result, legacy);
  }
  assert.equal(migrations, 0);
  assert.equal(detections, 0);
});

test('affirmative approval migrates and redetects the directory backend', async () => {
  const directory = { backend: 'directory' };
  const calls = [];
  const result = await offerLegacyMigration(legacy, '/repo', { 'ticket-store': 'custom' }, {
    input: tty,
    output: tty,
    emit() {},
    ask: async () => 'yes',
    plan: () => ({ operation: 'migrate' }),
    migrate: (root, options) => calls.push(['migrate', root, options]),
    detect: (options) => { calls.push(['detect', options]); return directory; },
  });
  assert.equal(result, directory);
  assert.deepEqual(calls, [
    // key/allowUnsigned are threaded through, at their fail-closed defaults here:
    // a legacy store that declares rails is a frozen trust root, and the migration
    // refuses one it cannot sign. Dropping them at this boundary would refuse the
    // operator who HAS a key, after they already answered yes.
    ['migrate', '/repo', { write: true, yes: true, key: null, allowUnsigned: false }],
    ['detect', { root: '/repo', ticketStore: 'custom', legacyTickets: undefined }],
  ]);
});

test('non-interactive and JSON paths never plan, prompt, or migrate', async () => {
  for (const [flags, input, output] of [[{}, pipe, tty], [{}, tty, pipe], [{ json: true }, tty, tty]]) {
    const result = await offerLegacyMigration(legacy, '/unused', flags, {
      input,
      output,
      plan: () => { throw new Error('must not plan'); },
      ask: async () => { throw new Error('must not prompt'); },
      migrate: () => { throw new Error('must not migrate'); },
    });
    assert.equal(result, legacy);
  }
});
