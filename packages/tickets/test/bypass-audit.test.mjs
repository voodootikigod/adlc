// bypass-audit.test.mjs — T-01M0122WMF8EJTB7ERHTEG8HMJ.
//
// THE GAP THIS PINS. Once any ticket declares a rail, the ticket store is a
// frozen trust root: the PreToolUse rail hook refuses a structured edit to
// `.adlc/tickets/**` unless ADLC_RAILS_BYPASS is set AND the override is
// recorded to the gate-manifest, and the /adlc:adlc-ticket text tells operators
// that "editing the ticket set while rails are frozen is a deliberate, audited
// action". The CLI reaches the same bytes by a different door — a Bash command
// the hook deliberately does not parse — and used to arrive unaudited: with a
// rails-declaring ticket in the store and no signing key, `adlc ticket create
// --write` exited 0, MUTATED the store, and recorded ZERO manifest entries.
//
// The probe below is that empirical repro, kept as the first test. Everything
// after it is the contract that closes it: every mutation of a frozen trust
// root records exactly one signed manifest entry, and a mutation that cannot be
// signed refuses BEFORE it touches the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../lib/canonical.mjs';
import { TRANSACTION_DIRECTORY } from '../lib/constants.mjs';
import {
  assertSignableTrustRootWrite, assertWriteIsSignable, repoDeclaresRails, storeDeclaresRails,
} from '../lib/trust-root.mjs';
import {
  DirectoryTicketStore, TicketService, applyDirectoryTransaction, applyLegacyTransaction, archiveTicket, exportLegacyStore,
  LegacyTicketStore, migrateLegacyStore, offerLegacyMigration, pendingTransactions,
  recordTicketEvidence, recoverDirectoryTransaction, recoverMigration, restoreTicket,
  ticketFilename, ticketHash,
} from '../index.mjs';
import { ticket, writeDirectory, writeLegacy } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/adlc-tickets.mjs', import.meta.url));
const KEY = 'test-manifest-key';
const MANIFEST = '.adlc/manifest.jsonl';

/**
 * Run the ticket CLI in `root`. The default environment is the empirical
 * probe's: an ACTIVE rails bypass and NO signing key. `ADLC_MANIFEST_KEY: ''`
 * rather than a delete, so an inherited key on the developer's shell cannot
 * quietly turn a keyless test into a signed one.
 */
function runTicket(root, args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, ADLC_RAILS_BYPASS: '1', ADLC_MANIFEST_KEY: '', ADLC_REVISION: 'rev-test', ...env },
  });
}

const storeHashOf = (root) => {
  const status = runTicket(root, ['store', 'status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  return JSON.parse(status.stdout).storeHash;
};

const manifestEntries = (root) => {
  const path = join(root, MANIFEST);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
};

function repo(tickets) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-'));
  writeDirectory(root, tickets);
  return root;
}

/** Write a ticket document to a temp file and return its path. */
function inputFile(root, document) {
  const path = join(root, 'input.json');
  writeFileSync(path, `${JSON.stringify(document)}\n`);
  return path;
}

const newTicket = (id, extra = {}) => ({ id, title: `Ticket ${id}`, category: 'feature', duration: 1, body: 'x', scope: [], rails: [], edges: [], ...extra });

// v1 signing — the shape recordTicketEvidence uses for a non-anchor entry.
const signV1 = (key, entry) => createHmac('sha256', key)
  .update(JSON.stringify({
    seq: entry.seq,
    gate: entry.gate,
    ts: entry.ts,
    ...(entry.ticket !== undefined ? { ticket: entry.ticket } : {}),
    ...(entry.data !== undefined ? { data: entry.data } : {}),
    files: entry.files,
    prev: entry.prev,
  }))
  .digest('hex');

test('EMPIRICAL PROBE (the bug): a keyless bypassed create against a frozen trust root no longer mutates in silence', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] })]);
  try {
    const before = storeHashOf(root);
    const result = runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--json']);

    assert.notEqual(result.status, 0, 'the unaudited mutation must not succeed');
    assert.equal(storeHashOf(root), before, 'the store must be byte-identical: the refusal precedes the write');
    assert.equal(manifestEntries(root).length, 0, 'a refused mutation records nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1 rails frozen + key present: create --write appends exactly ONE signed ticket-mutation entry bound to the new store hash', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] })]);
  try {
    const before = storeHashOf(root);
    const result = runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--json'], { ADLC_MANIFEST_KEY: KEY });
    assert.equal(result.status, 0, result.stderr);

    const entries = manifestEntries(root);
    assert.equal(entries.length, 1, 'exactly one entry per mutation');
    const [entry] = entries;
    assert.equal(entry.gate, 'ticket-mutation');
    assert.equal(entry.ticket, 'T-NEW');
    assert.equal(entry.data.op, 'create');
    assert.equal(entry.data.ticketId, 'T-NEW');
    assert.equal(entry.data.bypass, true);
    assert.equal(entry.data.storeHashBefore, before);
    // AC1's binding: storeHashAfter is what `ticket store status --json` reports now.
    assert.equal(entry.data.storeHashAfter, storeHashOf(root));
    assert.notEqual(entry.data.storeHashAfter, before, 'the audited mutation actually changed the store');
    assert.equal(entry.sig, signV1(KEY, entry), 'the entry is SIGNED with the configured key');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2 rails frozen + NO key: create --write refuses before writing, names the key, and leaves no pending transaction', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] })]);
  try {
    const before = storeHashOf(root);
    const result = runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--json']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ADLC_MANIFEST_KEY/, 'the refusal names the missing key');
    assert.match(result.stderr, /--allow-unsigned/, 'the refusal names the deliberate opt-out');
    assert.equal(storeHashOf(root), before, 'store hash unchanged');
    assert.equal(manifestEntries(root).length, 0);
    assert.equal(existsSync(join(root, TRANSACTION_DIRECTORY)), false, 'no half-open transaction was left behind');
    const list = runTicket(root, ['list', '--json']);
    assert.equal(JSON.parse(list.stdout).some((item) => item.id === 'T-NEW'), false, 'the ticket never entered the store');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2 opt-out: --allow-unsigned writes the mutation and an UNSIGNED audit entry, and warns what that costs', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] })]);
  try {
    const result = runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--allow-unsigned', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const entries = manifestEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].gate, 'ticket-mutation');
    assert.equal(entries[0].sig, undefined, 'no key, so the entry is unsigned');
    assert.match(result.stderr, /unsigned/i, 'the warning names the consequence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The warning lived after the store subcommands' early returns, so the two
// operations that rewrite the WHOLE store were the only ones that could record an
// unsigned entry silently.
test('the unsigned warning reaches the store ceremonies too, not just ticket mutations', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-ceremony-warn-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    // The warning lands BEFORE the migration does any work — here it stops on the
    // clean-worktree probe (this temp dir is not a git repo), and the operator has
    // still been told what the flag would cost.
    const migrate = runTicket(root, ['store', 'migrate', '--write', '--yes', '--allow-unsigned', '--json']);
    assert.match(migrate.stderr, /unsigned/i, 'store migrate --allow-unsigned warns');

    const recover = runTicket(root, ['store', 'recover', '--complete', '--allow-unsigned', '--json']);
    assert.match(recover.stderr, /unsigned/i, 'store recover --allow-unsigned warns (before it reports no pending work)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// archive and restore dispatch through their own branch, so it is worth pinning
// that they still reach the warning — and reach it exactly ONCE. A second copy
// would be its own defect: a warning printed twice reads as two problems.
test('archive warns exactly once about an unsigned audit entry, like every other mutation', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] }), ticket('T-OLD')]);
  try {
    const result = runTicket(root, ['archive', 'T-OLD', '--write', '--authorize', '--allow-unsigned', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.match(/recorded UNSIGNED/g)?.length, 1, 'warned, and only once');
    const [entry] = manifestEntries(root);
    assert.equal(entry.gate, 'ticket-archive');
    assert.equal(entry.data.bypass, true);
    assert.equal(entry.sig, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2 --allow-unsigned is inert when a key IS present: the entry is still signed, and nothing warns', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] })]);
  try {
    const result = runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--allow-unsigned', '--json'], { ADLC_MANIFEST_KEY: KEY });
    assert.equal(result.status, 0, result.stderr);
    const [entry] = manifestEntries(root);
    assert.equal(entry.sig, signV1(KEY, entry));
    // The warning is about an UNSIGNED entry. Printing it over a signed one
    // teaches operators that the warning is noise, which is how the real one
    // gets ignored — so the flag alone must not trigger it.
    assert.doesNotMatch(result.stderr, /unsigned/i, 'no key was missing, so there is nothing to warn about');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// `--allow-unsigned` has to be parsed as a BOOLEAN. Were it value-taking, it
// would silently swallow whichever flag follows it, and the failure would land
// somewhere else entirely — here, on the eaten `--input`.
test('--allow-unsigned takes no value: flag order does not change the outcome', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] })]);
  try {
    const result = runTicket(root, ['create', '--allow-unsigned', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(manifestEntries(root).length, 1);
    const list = runTicket(root, ['list', '--json']);
    assert.equal(JSON.parse(list.stdout).some((item) => item.id === 'T-NEW'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The bin always passes `allowUnsigned` explicitly, so only a LIBRARY caller can
// reach the default — and a default of `true` would silently reopen the hole for
// every programmatic writer (fleet, ticket-sync, ticket-prune) while every
// CLI-level test above still passed.
test('TicketService defaults allowUnsigned OFF: omitting it refuses a keyless write to a trust root', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-default-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    const before = store.load().hash;
    const service = new TicketService(store, { root, key: null }); // allowUnsigned OMITTED
    assert.throws(
      () => service.apply(service.planCreate({ id: 'T-NEW', title: 'new', scope: [], rails: [], edges: [] })),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
    assert.equal(store.load().hash, before, 'and the store is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// storeDeclaresRails is the predicate the whole audit hangs on. Reading an
// unparseable store as "no rails" would silently turn every trust root whose
// snapshot shape regressed into an unaudited one, which is the exact failure the
// fail-closed default exists to prevent.
test('storeDeclaresRails fails CLOSED on anything it cannot read as a definite no-rails', () => {
  assert.equal(storeDeclaresRails([ticket('A')]), false, 'an empty rails array is a definite no');
  assert.equal(storeDeclaresRails([]), false, 'so is an empty store');
  assert.equal(storeDeclaresRails([ticket('A'), ticket('B', { rails: ['x/**'] })]), true);
  assert.equal(storeDeclaresRails([ticket('A', { rails: ['x/**'], completed: true })]), true, 'completed rails still freeze the trust root');
  for (const unreadable of [null, undefined, 'tickets', 42, { tickets: [] }]) {
    assert.equal(storeDeclaresRails(unreadable), true, `a non-array store (${typeof unreadable}) must fail closed`);
  }
  for (const entry of [null, 'ticket', 7, ['not', 'an', 'object']]) {
    assert.equal(storeDeclaresRails([entry]), true, 'a ticket that is not an object may be hiding a rail');
  }
  assert.equal(storeDeclaresRails([{ id: 'A', rails: 'src/**' }]), true, 'a non-array rails field is not a definite no');
  // ABSENT is the only shape that reads as a definite no. `null` is a malformed
  // field, and ticket-prune re-reads the raw envelope under its lock, so an
  // unvalidated edit can reach this predicate.
  assert.equal(storeDeclaresRails([{ id: 'A' }]), false, 'an absent rails field is a definite no');
  assert.equal(storeDeclaresRails([{ id: 'A', rails: null }]), true, 'but null is malformed, not absent');
  assert.equal(storeDeclaresRails([{ id: 'A', rails: 0 }]), true);
  assert.equal(storeDeclaresRails([{ id: 'A', rails: {} }]), true);
});

test('AC3 no rails declared anywhere: create --write records nothing and succeeds with no key', () => {
  const root = repo([ticket('A')]); // rails: []
  try {
    const result = runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(manifestEntries(root).length, 0, 'pre-bootstrap authoring stays zero-ceremony');
    const list = runTicket(root, ['list', '--json']);
    assert.equal(JSON.parse(list.stdout).some((item) => item.id === 'T-NEW'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// #162: the freeze keys off "this repo uses rails at all", not "a rail is in
// force right now" — otherwise completing the last railed ticket would unfreeze
// the trust root and let one unaudited edit rewrite the rail config itself.
test('AC3 boundary: a COMPLETED ticket\'s rails still make the store a frozen trust root', () => {
  const root = repo([ticket('T-DONE', { rails: ['src/**'], completed: true })]);
  try {
    const result = runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--json']);
    assert.notEqual(result.status, 0, 'expired rails do not thaw the trust root');
    assert.equal(manifestEntries(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4 update (no sensitive change) under a frozen trust root records one ticket-mutation entry', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] }), ticket('T-EDIT')]);
  try {
    const before = storeHashOf(root);
    const show = runTicket(root, ['show', 'T-EDIT', '--json']);
    const { ticket: current, ticketHash } = JSON.parse(show.stdout);
    const result = runTicket(
      root,
      ['update', 'T-EDIT', '--input', inputFile(root, { ...current, title: 'edited body' }), '--expect', ticketHash, '--write', '--json'],
      { ADLC_MANIFEST_KEY: KEY },
    );
    assert.equal(result.status, 0, result.stderr);

    const entries = manifestEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].gate, 'ticket-mutation');
    assert.equal(entries[0].data.op, 'update');
    assert.equal(entries[0].data.ticketId, 'T-EDIT');
    assert.equal(entries[0].data.storeHashBefore, before);
    assert.equal(entries[0].data.storeHashAfter, storeHashOf(root));
    assert.equal(entries[0].sig, signV1(KEY, entries[0]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4 complete under a frozen trust root records one entry carrying the bypass audit', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] }), ticket('T-DOING')]);
  try {
    const before = storeHashOf(root);
    const result = runTicket(root, ['complete', 'T-DOING', '--write', '--json'], { ADLC_MANIFEST_KEY: KEY });
    assert.equal(result.status, 0, result.stderr);

    const entries = manifestEntries(root);
    assert.equal(entries.length, 1, 'one mutation, one entry');
    assert.equal(entries[0].data.op, 'complete');
    assert.equal(entries[0].data.bypass, true);
    assert.equal(entries[0].data.storeHashBefore, before);
    assert.equal(entries[0].data.storeHashAfter, storeHashOf(root));
    assert.equal(entries[0].sig, signV1(KEY, entries[0]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC4 complete under a frozen trust root REFUSES with no key, exactly like create', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] }), ticket('T-DOING')]);
  try {
    const before = storeHashOf(root);
    const result = runTicket(root, ['complete', 'T-DOING', '--write', '--json']);
    assert.notEqual(result.status, 0);
    assert.equal(storeHashOf(root), before);
    assert.equal(manifestEntries(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The half of AC4 that guards against over-recording: a rail-narrowing update
// already appended a signed `ticket-update` entry before this ticket existed.
// Auditing the bypass must not turn one mutation into two manifest entries.
test('AC4 update --authorize (rail narrowing) keeps its existing entry — one mutation, NOT two', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**', 'lib/**'] })]);
  try {
    const before = storeHashOf(root);
    const show = runTicket(root, ['show', 'T-RAILED', '--json']);
    const { ticket: current, ticketHash } = JSON.parse(show.stdout);
    const result = runTicket(
      root,
      ['update', 'T-RAILED', '--input', inputFile(root, { ...current, rails: ['src/**'] }), '--expect', ticketHash, '--authorize', '--write', '--json'],
      { ADLC_MANIFEST_KEY: KEY },
    );
    assert.equal(result.status, 0, result.stderr);

    const entries = manifestEntries(root);
    assert.equal(entries.length, 1, 'exactly one entry for one mutation');
    assert.equal(entries[0].gate, 'ticket-update', 'the sensitive mutation keeps its own gate');
    assert.equal(entries[0].data.bypass, true, 'and gains the bypass audit fields');
    assert.equal(entries[0].data.storeHashBefore, before);
    assert.equal(entries[0].sig, signV1(KEY, entries[0]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A converged sync applies nothing. Demanding a key to apply nothing would break
// ordinary idempotent syncing, and recording an entry whose before and after hashes
// are equal would claim a mutation that never happened — a scheduled pull would
// grow the append-only manifest forever with records of nothing.
test('a NO-OP transaction against a frozen trust root needs no key and records nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-noop-'));
  try {
    const tickets = [ticket('T-RAILED', { rails: ['src/**'] }), ticket('B')];
    const path = writeDirectory(root, tickets);
    const store = new DirectoryTicketStore(path);
    const before = store.load().hash;

    // Same logical content: converged.
    const after = applyDirectoryTransaction(store, store.load().mutableTickets(), {
      root, operation: 'remote-reconciliation', key: null,
    });

    assert.equal(after.hash, before, 'nothing changed');
    assert.equal(manifestEntries(root).length, 0, 'so nothing was recorded');

    // And a real change through the same path still refuses without a key.
    assert.throws(
      () => applyDirectoryTransaction(store, [...store.load().mutableTickets(), ticket('C')], {
        root, operation: 'remote-reconciliation', key: null,
      }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'the no-op exemption is about change, not about the path',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an UNRAILED store keeps its existing evidence shape byte for byte — the change is scoped to frozen trust roots', () => {
  const root = repo([ticket('T-DOING')]);
  try {
    const result = runTicket(root, ['complete', 'T-DOING', '--write', '--json'], { ADLC_MANIFEST_KEY: KEY });
    assert.equal(result.status, 0, result.stderr);
    const [entry] = manifestEntries(root);
    assert.equal(entry.gate, 'ticket-complete');
    assert.equal(entry.data.bypass, undefined, 'no bypass audit fields on a store that is not a trust root');
    assert.equal(entry.data.storeHashBefore, undefined);
    assert.equal(entry.data.op, undefined);
    assert.deepEqual(
      Object.keys(entry.data).sort(),
      ['action', 'bindingScope', 'operation', 'revision', 'storeHash', 'ticketHash', 'transactionId'],
    );
    assert.equal(entry.sig, signV1(KEY, entry));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- the OTHER doors into the same bytes -------------------------------------
//
// A rule enforced on one write path and not the others is not a rule. Each test
// below drives a different entrypoint that reaches the same trust root the CLI
// does, and pins that it is held to the same contract.

test('archive REFUSES a keyless write to a trust root leaving NO filesystem trace — not even the archive store', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-archive-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] }), ticket('T-OLD')]);
    const store = new DirectoryTicketStore(path);
    const before = store.load().hash;
    assert.throws(
      () => archiveTicket(store, join(root, '.adlc/ticket-archive'), 'T-OLD', {
        expectedSnapshotHash: before, root, authorized: true, key: null,
      }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
    assert.equal(store.load().hash, before, 'the active store is unchanged');
    // The refusal used to land AFTER ensureArchive, so a refused archive still
    // created the archive store as an untracked side effect.
    assert.equal(existsSync(join(root, '.adlc/ticket-archive')), false, 'and no archive store was created');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive with a key still works and records its own gate, now carrying the bypass audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-archive-ok-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] }), ticket('T-OLD')]);
    const store = new DirectoryTicketStore(path);
    const before = store.load().hash;
    archiveTicket(store, join(root, '.adlc/ticket-archive'), 'T-OLD', {
      expectedSnapshotHash: before, root, authorized: true, key: KEY,
    });
    const entries = manifestEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].gate, 'ticket-archive', 'an operation with its own gate keeps it');
    assert.equal(entries[0].data.bypass, true);
    assert.equal(entries[0].data.storeHashBefore, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a legacy-store migration REFUSES without a key when the store it rewrites declares rails', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-migrate-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    assert.throws(
      () => migrateLegacyStore(root, { write: true, yes: true, requireClean: false, key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
    assert.equal(existsSync(join(root, '.adlc/tickets')), false, 'no directory store was staged into place');
    assert.equal(manifestEntries(root).length, 0);
    // The preview is a read, so it stays available without a key — an operator has
    // to be able to see what the migration would do before finding the key.
    assert.equal(migrateLegacyStore(root, { key: null }).beforeHash.length, 64);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an UNRAILED legacy store still migrates with no key — migration is not ceremony by itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-migrate-unrailed-'));
  try {
    writeLegacy(root, [ticket('A')]);
    migrateLegacyStore(root, { write: true, yes: true, requireClean: false, key: null });
    assert.equal(existsSync(join(root, '.adlc/tickets')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Recovery is the one path that can finish a mutation the initiating check already
// cleared. Left keyless, it was the way to change a trust root and leave only an
// unsigned, forgeable record of it.
test('recovery REFUSES to finish a bypassed mutation without a key, and leaves the transaction pending', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-recover-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    const before = store.load().hash;
    // Interrupt a signed, authorized mutation just before its final verify.
    assert.throws(() => applyDirectoryTransaction(store, [...store.load().mutableTickets(), ticket('T-NEW')], {
      root, operation: 'create', ticketId: 'T-NEW', key: KEY,
      faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
    }), /crash/);
    const [pending] = pendingTransactions(root);
    assert.ok(pending, 'the crash left a recoverable transaction');

    assert.throws(
      () => recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'a keyless recovery of a trust-root mutation is refused, not silently unsigned',
    );
    assert.deepEqual(pendingTransactions(root), [pending], 'and the transaction stays recoverable');

    // With the key it completes and records the audit — nothing is stranded.
    recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: KEY });
    const entries = manifestEntries(root);
    const recovery = entries.find((entry) => entry.data.action === 'recover-complete');
    assert.ok(recovery, 'the recovery is audited');
    assert.equal(recovery.data.bypass, true);
    assert.equal(recovery.sig, signV1(KEY, recovery));

    // And the ORIGINAL transition is in the ledger too. The crash landed before the
    // apply evidence was written, so without this the only record would be the
    // recovery's own step — bound from the already-applied after-state to itself,
    // with the real before → after mutation of a trust root appearing nowhere.
    const applied = entries.find((entry) => entry.data.action === 'apply');
    assert.ok(applied, 'the mutation that was completed is recorded');
    assert.equal(applied.data.bypass, true);
    assert.equal(applied.data.storeHashBefore, before, 'bound to where the store actually started');
    assert.equal(applied.data.storeHashAfter, store.load().hash, 'and where it ended up');
    assert.notEqual(applied.data.storeHashBefore, applied.data.storeHashAfter);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The bootstrap case, in reverse. A create that introduces the FIRST rail runs
// against a store that is NOT yet a trust root, so it needs no key — but the moment
// its shard lands the store looks frozen. Reading the store whole at recovery time
// would demand a key to finish (or undo) a mutation that legitimately needed none,
// deadlocking ordinary keyless authoring in both directions.
test('recovering the transaction that introduced the FIRST rail needs no key', () => {
  for (const direction of ['complete', 'rollback']) {
    const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-first-rail-'));
    try {
      const path = writeDirectory(root, [ticket('A')]); // no rails anywhere yet
      const store = new DirectoryTicketStore(path);
      assert.throws(() => applyDirectoryTransaction(store, [ticket('A'), ticket('T-RAILED', { rails: ['src/**'] })], {
        root, operation: 'create', ticketId: 'T-RAILED', key: null,
        faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
      }), /crash/);
      const [pending] = pendingTransactions(root);
      assert.ok(pending);
      assert.equal(storeDeclaresRails(store.load().tickets), true,
        'precondition: the half-applied store already looks like a trust root');

      // Keyless, and it must resolve — the transaction being recovered is the one
      // that created the rail, not a write against an already-frozen store.
      recoverDirectoryTransaction(store, pending, { root, direction, key: null });
      assert.deepEqual(pendingTransactions(root), [], `${direction} resolved without a key`);
      assert.equal(manifestEntries(root).length, 0, 'and recorded nothing, since no trust root was overridden');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

// Same boundary, reached by REPLACING a shard rather than adding one: an update
// that puts the first rail on an existing rails-free ticket. Excluding only the
// added shards left this one looking railed, and its recovery deadlocked.
test('recovering an UPDATE that introduced the first rail needs no key either', () => {
  for (const direction of ['complete', 'rollback']) {
    const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-first-rail-update-'));
    try {
      const path = writeDirectory(root, [ticket('A')]); // exists, rails-free
      const store = new DirectoryTicketStore(path);
      assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { rails: ['src/**'] })], {
        root, operation: 'update', ticketId: 'A', key: null,
        faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
      }), /crash/);
      const [pending] = pendingTransactions(root);
      assert.equal(storeDeclaresRails(store.load().tickets), true,
        'precondition: the replaced shard already carries the new rail');

      recoverDirectoryTransaction(store, pending, { root, direction, key: null });
      assert.deepEqual(pendingTransactions(root), [], `${direction} resolved without a key`);
      assert.equal(manifestEntries(root).length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

// Restoring the last railed ARCHIVED ticket removes it from the archive and adds it
// to the active store. Reconstructing the pre-transaction state subtracts the added
// shard, and the archive is now empty — so the auxiliary backup holding the archived
// ticket is the only surviving witness that this repo ever used rails.
test('recovering a restore of the last railed ARCHIVED ticket still requires a key', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-restore-'));
  try {
    const path = writeDirectory(root, [ticket('A')]); // active set declares no rails
    const store = new DirectoryTicketStore(path);
    const railed = ticket('T-RAILED', { rails: ['src/**'] });
    writeDirectory(root, [], { archive: true });
    writeFileSync(
      join(root, '.adlc/ticket-archive', ticketFilename('T-RAILED')),
      `${JSON.stringify({ ...railed, _adlcArchive: { version: 1, archivedAt: 'T', reason: 'completed', ticketHash: ticketHash(railed), sourceStoreHash: 'x', sourceRevision: null } }, null, 2)}\n`,
    );
    assert.equal(repoDeclaresRails(root, store.load().tickets), true, 'precondition: the archive holds the rail');

    assert.throws(() => restoreTicket(store, join(root, '.adlc/ticket-archive'), 'T-RAILED', {
      expectedSnapshotHash: store.load().hash, root, authorized: true, key: KEY,
      faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
    }), /crash/);
    const [pending] = pendingTransactions(root);
    assert.ok(pending);

    // The crash window: the archive shard is gone and the active shard has landed,
    // so subtracting the addition leaves nothing declaring a rail anywhere.
    assert.equal(existsSync(join(root, '.adlc/ticket-archive', ticketFilename('T-RAILED'))), false);
    // And the journal's own flag is stripped, leaving only the auxiliary backup.
    const journalPath = join(root, TRANSACTION_DIRECTORY, pending, 'journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    writeFileSync(journalPath, `${JSON.stringify({ ...journal, bypassAudit: false }, null, 2)}\n`);

    assert.throws(
      () => recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'the archived shard in the auxiliary backup still proves this is a trust root',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Swapping a backup for a rails-free one is the cheap half of tampering with a
// recovery: it needs no journal edit at all. The recorded per-file hash catches it.
test('a backup that does not match its recorded hash is not believed', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-swapped-backup-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    // Discard the only railed ticket, crashing after the shard was removed.
    assert.throws(() => applyDirectoryTransaction(store, [], {
      root, operation: 'discard', ticketId: 'T-RAILED', key: KEY,
      faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
    }), /crash/);
    const [pending] = pendingTransactions(root);

    // Strip the journal's flag AND swap the backup for a rails-free ticket, leaving
    // no honest witness anywhere — except the hash the journal recorded for it.
    const journalPath = join(root, TRANSACTION_DIRECTORY, pending, 'journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    writeFileSync(journalPath, `${JSON.stringify({ ...journal, bypassAudit: false }, null, 2)}\n`);
    const backup = journal.operations.find((operation) => operation.backup)?.backup;
    assert.ok(backup, 'the discard kept a backup of the removed shard');
    writeFileSync(join(root, backup), `${JSON.stringify(ticket('T-RAILED'), null, 2)}\n`); // rails stripped

    assert.throws(
      () => recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'the swapped backup no longer matches its recorded hash, so it is not believed',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The LEGACY backend records one envelope target, not shard filenames, so the
// shard-name filter matches nothing there — leaving the whole post-change store in
// the reconstruction and deadlocking exactly the keyless recovery the sharded path
// already handles.
test('recovering a LEGACY write that introduced the first rail needs no key', () => {
  for (const direction of ['complete', 'rollback']) {
    const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-legacy-first-rail-'));
    try {
      writeLegacy(root, [ticket('A')]); // rails-free flat store
      const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
      assert.throws(() => applyLegacyTransaction(store, [ticket('A'), ticket('T-RAILED', { rails: ['src/**'] })], {
        root, operation: 'create', ticketId: 'T-RAILED', key: null,
        faultInjector: (stage) => { if (stage === 'operation-applied:1') throw new Error('crash'); },
      }), /crash/);
      const [pending] = pendingTransactions(root);
      assert.ok(pending, 'the crash left a recoverable transaction');
      assert.equal(storeDeclaresRails(store.load().tickets), true,
        'precondition: the replaced envelope already carries the new rail');

      recoverDirectoryTransaction(store, pending, { root, direction, key: null });
      assert.deepEqual(pendingTransactions(root), [], `${direction} resolved without a key`);
      assert.equal(manifestEntries(root).length, 0, 'and recorded nothing — no trust root was overridden');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

// A journal written before `bypassAudit` existed says nothing about whether an
// audit is owed. Reading that silence as "no" would make "crash, then upgrade,
// then recover" the one unaudited route into a trust root.
test('a legacy journal with no bypassAudit field falls back to the store, and fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-legacy-journal-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    assert.throws(() => applyDirectoryTransaction(store, [...store.load().mutableTickets(), ticket('T-NEW')], {
      root, operation: 'create', ticketId: 'T-NEW', key: KEY,
      faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
    }), /crash/);
    const [pending] = pendingTransactions(root);

    // Age the journal back to the pre-field shape.
    const journalPath = join(root, TRANSACTION_DIRECTORY, pending, 'journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    delete journal.bypassAudit;
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    assert.throws(
      () => recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// recoverMigration is the migration's twin of the recovery hole above, and its
// opt-out has to default OFF for the same reason: a caller that simply omits the
// option must get the refusal, not a silent unsigned record.
test('recoverMigration defaults allowUnsigned OFF: finishing an interrupted trust-root migration needs a key', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-migrate-recover-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    assert.throws(() => migrateLegacyStore(root, {
      write: true, yes: true, requireClean: false, key: KEY,
      faultInjector(name) { if (name === 'directory-renamed') throw new Error('fault'); },
    }), /fault/);
    const [id] = pendingTransactions(root);
    assert.ok(id, 'the crash left a recoverable migration');

    for (const direction of ['complete', 'rollback']) {
      assert.throws(
        () => recoverMigration(root, id, { direction, key: null }), // allowUnsigned OMITTED
        (error) => error.code === 'MANIFEST_KEY_REQUIRED',
        `a keyless ${direction} of a trust-root migration is refused`,
      );
    }
    assert.deepEqual(pendingTransactions(root), [id], 'and the migration stays recoverable');
    recoverMigration(root, id, { direction: 'complete', key: KEY });
    assert.deepEqual(pendingTransactions(root), [], 'the key finishes it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The journal is a plain file on disk, not signed evidence. An earlier revision
// read `bypassAudit` as authoritative whenever it was a boolean, so one text edit
// switched off both the refusal and the audit for a recovery.
test('recovery ignores a journal that claims NO audit is owed — the store decides, the journal may only add', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-tampered-journal-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    assert.throws(() => applyDirectoryTransaction(store, [...store.load().mutableTickets(), ticket('T-NEW')], {
      root, operation: 'create', ticketId: 'T-NEW', key: KEY,
      faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
    }), /crash/);
    const [pending] = pendingTransactions(root);

    // The forgery: flip the one field that used to decide this.
    const journalPath = join(root, TRANSACTION_DIRECTORY, pending, 'journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(journal.bypassAudit, true, 'precondition: the honest journal says an audit is owed');
    writeFileSync(journalPath, `${JSON.stringify({ ...journal, bypassAudit: false }, null, 2)}\n`);

    assert.throws(
      () => recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'the tampered journal does not disable the refusal',
    );
    recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: KEY });
    const recovery = manifestEntries(root).find((entry) => entry.data.action === 'recover-complete');
    assert.ok(recovery, 'nor does it suppress the audit entry');
    assert.equal(recovery.data.bypass, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The shared guard is exported, so a library caller can reach it directly. An
// omitted key must not read as "a key is present" — that is the fail-OPEN reading
// of the single thing it exists to refuse.
test('the exported trust-root guard fails CLOSED on an omitted or invalid key, per the key contract', () => {
  const railed = [ticket('T-RAILED', { rails: ['src/**'] })];
  // No options bag at all.
  assert.throws(() => assertSignableTrustRootWrite(railed), TypeError);
  for (const bad of [undefined, '', 0, false, {}]) {
    assert.throws(
      () => assertSignableTrustRootWrite(railed, { key: bad }),
      TypeError,
      `key ${JSON.stringify(bad)} is a caller bug, not a usable key`,
    );
    assert.throws(() => assertWriteIsSignable({ key: bad }), TypeError);
  }
  // An explicit null is the legal "no key" form, and THAT is what refuses.
  assert.throws(
    () => assertSignableTrustRootWrite(railed, { key: null }),
    (error) => error.code === 'MANIFEST_KEY_REQUIRED',
  );
  // The two legal ways through.
  assert.equal(assertSignableTrustRootWrite(railed, { key: KEY }), true);
  assert.equal(assertSignableTrustRootWrite(railed, { key: null, allowUnsigned: true }), true);
  // And a store that is not a trust root never reaches the key question at all.
  assert.equal(assertSignableTrustRootWrite([ticket('A')], { key: null }), false);
});

// The interactive accept path resolves the key at the bin and then hands the
// migration off. Dropping it at that boundary refuses exactly the operator who
// HAS a key, after they already answered "yes".
test('the interactive migration prompt carries the resolved key through to the migration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-prompt-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
    const seen = [];
    const offer = (options) => offerLegacyMigration(store, root, { json: false }, {
      ask: async () => 'y',
      emit: () => {},
      input: { isTTY: true },
      output: { isTTY: true, write: () => {} },
      migrate: (_root, opts) => { seen.push(opts); },
      detect: () => store,
      ...options,
    });

    await offer({ key: KEY });
    assert.equal(seen.at(-1).key, KEY, 'the key reaches migrateLegacyStore');
    await offer({ key: null, allowUnsigned: true });
    assert.equal(seen.at(-1).allowUnsigned, true, 'and so does the opt-out');
    // Omitting both is the fail-closed default the migration then refuses on.
    await offer({});
    assert.equal(seen.at(-1).key, null);
    assert.equal(seen.at(-1).allowUnsigned, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a migration of a trust root records its own gate carrying the audit fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-migrate-fields-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const before = new LegacyTicketStore(join(root, '.adlc/tickets.json')).load().hash;
    migrateLegacyStore(root, { write: true, yes: true, requireClean: false, key: KEY });

    const [entry] = manifestEntries(root);
    assert.equal(entry.gate, 'ticket-migrate', 'the migration keeps its own gate — one mutation, one entry');
    assert.equal(entry.data.bypass, true);
    assert.equal(entry.data.storeHashBefore, before);
    assert.equal(entry.data.storeHashAfter, entry.data.storeHash);
    assert.equal(entry.sig, signV1(KEY, entry));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an UNRAILED migration keeps its evidence shape unchanged — no audit fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-migrate-plain-'));
  try {
    writeLegacy(root, [ticket('A')]);
    migrateLegacyStore(root, { write: true, yes: true, requireClean: false, key: KEY });
    const [entry] = manifestEntries(root);
    assert.equal(entry.data.bypass, undefined);
    assert.equal(entry.data.storeHashBefore, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A crash can leave the store part-way between the journal's two hashes. Naming
// journal.beforeHash on a rollback would claim a transition that did not happen.
test('a recovery audit binds the hash the store ACTUALLY held when recovery started', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-recover-hash-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    const originalHash = store.load().hash;
    assert.throws(() => applyDirectoryTransaction(store, [...store.load().mutableTickets(), ticket('T-NEW')], {
      root, operation: 'create', ticketId: 'T-NEW', key: KEY,
      faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
    }), /crash/);
    const [pending] = pendingTransactions(root);
    // The crash landed AFTER the shards were applied, so the store now holds the
    // post-mutation state while the journal still records the pre-mutation one.
    const midCrashHash = store.load().hash;
    assert.notEqual(midCrashHash, originalHash, 'precondition: the store is past its journal beforeHash');

    recoverDirectoryTransaction(store, pending, { root, direction: 'rollback', key: KEY });
    const recovery = manifestEntries(root).find((entry) => entry.data.action === 'recover-rollback');
    assert.ok(recovery);
    assert.equal(recovery.data.storeHashBefore, midCrashHash, 'the audit names where the store really was');
    assert.equal(recovery.data.storeHashAfter, originalHash, 'and where the rollback put it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The escalation this closes: archiving the last railed ticket empties `rails` out
// of the ACTIVE set. A predicate reading only that set would report the store
// thawed from then on, so one key-authorized archive would switch the audit off
// permanently — the opposite of #162, which keeps the trust root frozen once rails
// have been declared at all.
test('archiving the LAST railed ticket does not thaw the trust root — the archive still declares rails', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-thaw-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    archiveTicket(store, join(root, '.adlc/ticket-archive'), 'T-RAILED', {
      expectedSnapshotHash: store.load().hash, root, authorized: true, key: KEY,
    });
    assert.deepEqual(store.load().tickets, [], 'the active store now declares no rails at all');

    // The active set alone says "not a trust root"; the repo says otherwise.
    assert.equal(storeDeclaresRails(store.load().tickets), false);
    assert.equal(repoDeclaresRails(root, store.load().tickets), true);

    const service = new TicketService(store, { root, key: null });
    assert.throws(
      () => service.apply(service.planCreate({ id: 'T-AFTER', title: 'after the thaw', scope: [], rails: [], edges: [] })),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'the write after the archive is still an audited override',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Anything in the archive that does not read as a ticket document is not proof
// that no rail is hiding there. Skipping such entries — by extension, or because
// they are directories — is the fail-OPEN answer.
test('an archive entry that cannot be read as a ticket fails CLOSED, whatever it is named', () => {
  const active = [ticket('A')];
  for (const [label, plant] of [
    ['malformed JSON', (dir) => writeFileSync(join(dir, 'broken--0.json'), '{ not json')],
    ['a non-.json name', (dir) => writeFileSync(join(dir, 'railed--0.JSON'), JSON.stringify(ticket('R', { rails: ['src/**'] })))],
    ['no extension at all', (dir) => writeFileSync(join(dir, 'railed-shard'), JSON.stringify(ticket('R', { rails: ['src/**'] })))],
    ['a directory', (dir) => mkdirSync(join(dir, 'nested'))],
    ['a JSON non-object', (dir) => writeFileSync(join(dir, 'weird--0.json'), '"just a string"')],
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-opaque-archive-'));
    try {
      writeDirectory(root, active); // no rails anywhere in the active set
      assert.equal(repoDeclaresRails(root, active), false, 'precondition: not a trust root yet');
      writeDirectory(root, [], { archive: true });
      plant(join(root, '.adlc/ticket-archive'));
      assert.equal(repoDeclaresRails(root, active), true, `${label} in the archive must fail closed`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

// The deepest form of the thaw: DISCARD deletes the ticket outright, so unlike
// archiving it leaves no copy anywhere in the ticket set. The manifest is what
// remembers — it is append-only, and the discard itself was audited on its way out.
test('discarding the LAST railed ticket does not thaw the trust root — the manifest remembers', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-discard-thaw-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    const service = new TicketService(store, { root, key: KEY });
    service.apply(service.planDiscard('T-RAILED'));

    assert.deepEqual(store.load().tickets, [], 'the ticket is gone entirely — not archived');
    assert.equal(existsSync(join(root, '.adlc/ticket-archive')), false, 'and there is no archive to fall back on');
    assert.equal(manifestEntries(root).some((entry) => entry.data.bypass === true), true,
      'but the discard recorded its own override on the way out');

    assert.equal(repoDeclaresRails(root, store.load().tickets), true, 'so the repo is still a trust root');
    const after = new TicketService(store, { root, key: null });
    assert.throws(
      () => after.apply(after.planCreate({ id: 'T-AFTER', title: 'after', scope: [], rails: [], edges: [] })),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Same for an authorized update that empties the last `rails` array.
test('emptying the last rails array does not thaw the trust root either', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-unrail-thaw-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    const service = new TicketService(store, { root, key: KEY });
    const current = store.load().get('T-RAILED');
    service.apply(service.planUpdate('T-RAILED', { ...current, rails: [] }, { authorized: true }));

    assert.deepEqual(store.load().get('T-RAILED').rails, [], 'no rail is declared anywhere now');
    assert.equal(storeDeclaresRails(store.load().tickets), false);
    assert.equal(repoDeclaresRails(root, store.load().tickets), true, 'the recorded override is what holds');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// existsSync follows links, so a DANGLING symlink reports the path as absent and
// the trust-root evidence it should have held disappears from the predicate. A live
// one redirects the read somewhere the attacker chose. Neither is proof of no rails.
test('a symlink where trust-root evidence belongs fails CLOSED, dangling or not', () => {
  const active = [ticket('A')];
  for (const [label, plant] of [
    ['a dangling archive directory', (root) => symlinkSync(join(root, 'nowhere'), join(root, '.adlc/ticket-archive'), 'dir')],
    ['a redirected archive directory', (root) => { mkdirSync(join(root, 'elsewhere')); symlinkSync(join(root, 'elsewhere'), join(root, '.adlc/ticket-archive'), 'dir'); }],
    ['a dangling legacy archive file', (root) => symlinkSync(join(root, 'nowhere.json'), join(root, '.adlc/tickets.archive.json'))],
    ['a dangling root manifest', (root) => symlinkSync(join(root, 'nowhere.jsonl'), join(root, '.adlc/manifest.jsonl'))],
    ['a dangling segment directory', (root) => symlinkSync(join(root, 'nowhere'), join(root, '.adlc/manifest.d'), 'dir')],
    ['a symlinked .adlc parent', (root) => {
      // lstat declines to follow only the FINAL component, so checking each evidence
      // path individually still reads straight through a linked parent.
      mkdirSync(join(root, 'elsewhere-adlc'));
      rmSync(join(root, '.adlc'), { recursive: true, force: true });
      symlinkSync(join(root, 'elsewhere-adlc'), join(root, '.adlc'), 'dir');
    }],
    ['a symlinked archive shard', (root) => {
      writeDirectory(root, [], { archive: true });
      symlinkSync(join(root, 'nowhere.json'), join(root, '.adlc/ticket-archive/shard.json'));
    }],
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-symlink-'));
    try {
      writeDirectory(root, active);
      assert.equal(repoDeclaresRails(root, active), false, 'precondition: not a trust root yet');
      plant(root);
      // A throw is the strongest fail-closed answer, and UNSAFE_STORE_PATH is the
      // actionable diagnosis — telling the operator to find a key would send them
      // after a problem no key can fix.
      assert.throws(
        () => repoDeclaresRails(root, active),
        (error) => error.code === 'UNSAFE_STORE_PATH',
        `${label} must fail closed`,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

// "Cannot tell" is not "no rails". An unreadable path and a corrupted marker are
// both states an attacker would engineer, and both used to read as absence.
test('an unreadable evidence path and a corrupted bypass marker both fail CLOSED', () => {
  const active = [ticket('A')];

  // PORTABLE: the archive path is a FILE where a directory belongs. readdirSync
  // fails ENOTDIR on every platform, and "cannot enumerate" is not "no rails".
  const notADirectory = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-notadir-'));
  try {
    writeDirectory(notADirectory, active);
    assert.equal(repoDeclaresRails(notADirectory, active), false, 'precondition: readable and rails-free');
    writeFileSync(join(notADirectory, '.adlc/ticket-archive'), 'not a directory\n');
    assert.equal(repoDeclaresRails(notADirectory, active), true, 'an unenumerable archive is not proof of absence');
  } finally { rmSync(notADirectory, { recursive: true, force: true }); }

  // PERMISSION DENIAL, where the OS actually offers it. Probed rather than assumed:
  // Windows chmod does not deny reads to the owner, and root bypasses the mode bits
  // entirely, so on those hosts this mechanism cannot produce the error class at all
  // and asserting it would be asserting the platform, not the code.
  const unreadable = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-unreadable-'));
  try {
    writeDirectory(unreadable, active);
    writeDirectory(unreadable, [], { archive: true }); // a real archive, marker included
    const adlc = join(unreadable, '.adlc');
    assert.equal(repoDeclaresRails(unreadable, active), false, 'precondition: readable and rails-free');

    let deniesReads = false;
    try {
      chmodSync(adlc, 0o000);
      readdirSync(adlc);
    } catch { deniesReads = true; }

    if (deniesReads) {
      try {
        assert.throws(
          () => repoDeclaresRails(unreadable, active),
          (error) => error.code === 'TRUST_ROOT_PATH_UNREADABLE',
          'a permission failure is not proof of absence',
        );
      } finally { chmodSync(adlc, 0o755); }
    } else {
      chmodSync(adlc, 0o755);
    }
  } finally { rmSync(unreadable, { recursive: true, force: true }); }

  // The sticky marker must not be erasable by truncating the one line that holds it.
  const corrupted = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-corrupt-marker-'));
  try {
    writeDirectory(corrupted, active);
    mkdirSync(join(corrupted, '.adlc'), { recursive: true });
    writeFileSync(join(corrupted, MANIFEST), '{"seq":1,"gate":"ticket-mutation","data":{"bypass":tr\n');
    assert.equal(repoDeclaresRails(corrupted, active), true, 'a truncated bypass line still counts');
  } finally { rmSync(corrupted, { recursive: true, force: true }); }
});

// The PreToolUse rail hook has always recorded its ADLC_RAILS_BYPASS overrides as a
// `rails-bypass` gate whose data carries only { path, reason } — no bypass field.
// That is the evidence a rails-using repo is most likely to already have, and
// ignoring it would let a hook override that removed the last rail thaw the root.
test("the rail hook's own rails-bypass entries keep the trust root frozen", () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-hook-marker-'));
  try {
    const active = [ticket('A')]; // no rail left anywhere
    writeDirectory(root, active);
    mkdirSync(join(root, '.adlc'), { recursive: true });
    assert.equal(repoDeclaresRails(root, active), false, 'precondition: nothing says rails yet');

    // Exactly what plugins/adlc-claude-code/hooks/adlc-hook.mjs records.
    writeFileSync(join(root, MANIFEST), `${JSON.stringify({
      seq: 1,
      gate: 'rails-bypass',
      ts: '2026-01-01T00:00:00.000Z',
      data: { path: 'src/guarded/thing.mjs', reason: 'rail-hit-bypass' },
      files: {},
      prev: null,
    })}\n`);

    assert.equal(repoDeclaresRails(root, active), true, 'a recorded hook override is durable evidence');
    const store = new DirectoryTicketStore(join(root, '.adlc/tickets'));
    const service = new TicketService(store, { root, key: null });
    assert.throws(
      () => service.apply(service.planCreate({ id: 'T-AFTER', title: 'after', scope: [], rails: [], edges: [] })),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an EMPTY archive next to a rails-free store is still not a trust root', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-empty-archive-'));
  try {
    writeDirectory(root, [ticket('A')]);
    writeDirectory(root, [ticket('OLD')], { archive: true }); // archived, but rails: []
    assert.equal(repoDeclaresRails(root, [ticket('A')]), false, 'no rails anywhere means no ceremony');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the LEGACY archive file counts too', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-legacy-archive-'));
  try {
    writeDirectory(root, [ticket('A')]);
    writeFileSync(
      join(root, '.adlc/tickets.archive.json'),
      `${JSON.stringify({ tickets: [ticket('OLD-RAILED', { rails: ['src/**'] })] }, null, 2)}\n`,
    );
    assert.equal(repoDeclaresRails(root, [ticket('A')]), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A transaction that DISCARDS the last railed ticket leaves an unrailed store
// behind, so recovering it would look like ordinary work. The journal's backups
// hold the pre-transaction shard, which still says otherwise.
test('recovery of a transaction that removed the last rail is still an audited trust-root write', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-lastrail-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] }), ticket('T-PLAIN')]);
    const store = new DirectoryTicketStore(path);
    // Discard the railed ticket, crashing after the shards were applied.
    assert.throws(() => applyDirectoryTransaction(store, [ticket('T-PLAIN')], {
      root, operation: 'discard', ticketId: 'T-RAILED', key: KEY,
      faultInjector: (stage) => { if (stage === 'before-final-verify') throw new Error('crash'); },
    }), /crash/);
    const [pending] = pendingTransactions(root);
    assert.equal(repoDeclaresRails(root, store.load().tickets), false,
      'precondition: the store on disk no longer declares any rail');

    // Strip the journal's own flag as well, leaving the backups as the only witness.
    const journalPath = join(root, TRANSACTION_DIRECTORY, pending, 'journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    writeFileSync(journalPath, `${JSON.stringify({ ...journal, bypassAudit: false }, null, 2)}\n`);

    assert.throws(
      () => recoverDirectoryTransaction(store, pending, { root, direction: 'complete', key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'the backup of the discarded railed shard still makes this a trust-root write',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The store classes are readers. A public `write(tickets)` that validated and
// replaced the whole store — no rails check, no key, no evidence — is a hole in
// this contract no matter who calls it, and it was a declared entrypoint.
test('no ticket store class can be written through UNAUDITED', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-readonly-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const path = join(root, '.adlc/tickets.json');
    const before = readFileSync(path, 'utf8');
    // `write` stays callable for 1.x compatibility, but it routes through the
    // audited transaction — so on a trust root with no key it refuses.
    assert.throws(
      () => new LegacyTicketStore(path).write([ticket('T-INJECTED')]),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
    assert.equal(readFileSync(path, 'utf8'), before, 'the store is untouched');
    for (const name of ['save', 'put', 'replace']) {
      for (const Store of [LegacyTicketStore, DirectoryTicketStore]) {
        assert.equal(typeof Store.prototype[name], 'undefined', `${Store.name}.${name} would bypass the audit`);
      }
    }
    assert.equal(typeof DirectoryTicketStore.prototype.write, 'undefined');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The 1.x published API. It keeps working — but through the audited path, so a
// rails-free store behaves exactly as before while a trust root is held to the
// contract instead of being written unaudited.
test('LegacyTicketStore.write still works for 1.x callers, and is now audited', () => {
  const plain = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-legacy-write-'));
  try {
    writeLegacy(plain, [ticket('A')]);
    const store = new LegacyTicketStore(join(plain, '.adlc/tickets.json'));
    const after = store.write([ticket('A'), ticket('B')]); // the 1.x one-argument call
    assert.deepEqual(after.tickets.map((t) => t.id).sort(), ['A', 'B']);
    assert.equal(manifestEntries(plain).length, 0, 'not a trust root: nothing recorded, as before');
  } finally { rmSync(plain, { recursive: true, force: true }); }

  const railed = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-legacy-write-railed-'));
  try {
    writeLegacy(railed, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new LegacyTicketStore(join(railed, '.adlc/tickets.json'));
    const before = readFileSync(join(railed, '.adlc/tickets.json'), 'utf8');
    assert.throws(
      () => store.write([ticket('T-RAILED', { rails: ['src/**'] }), ticket('B')]),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'a trust root is no longer writable unaudited through this door',
    );
    assert.equal(readFileSync(join(railed, '.adlc/tickets.json'), 'utf8'), before);

    store.write([ticket('T-RAILED', { rails: ['src/**'] }), ticket('B')], { key: KEY });
    const [entry] = manifestEntries(railed);
    assert.equal(entry.data.bypass, true, 'and with a key it records the override');
  } finally { rmSync(railed, { recursive: true, force: true }); }
});

// The adapter defaults the repository root to dirname(dirname(this.path)), which is
// sound ONLY for the canonical <root>/.adlc/tickets.json layout. For a store
// configured anywhere else that names an unrelated directory — and the trust-root
// predicate would then look for the archive, the manifest and the recorded overrides
// THERE, find nothing, and let a keyless unaudited write through the published
// one-argument API while the store's real repository is frozen.
test('LegacyTicketStore.write refuses to GUESS the repository root for a store outside the canonical layout', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-external-repo-'));
  const external = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-external-store-'));
  try {
    // The REPO is a frozen trust root — the rail lives in its archive.
    const active = [ticket('A')];
    writeDirectory(repoRoot, active);
    writeDirectory(repoRoot, [ticket('R', { rails: ['src/**'] })], { archive: true });
    assert.equal(repoDeclaresRails(repoRoot, active), true, 'precondition: the repository is frozen');

    // ...but its configured legacy store lives somewhere else entirely, and the
    // directory the old default would infer has no `.adlc` at all.
    const storeDir = join(external, 'adlc-store');
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, 'tickets.json');
    writeFileSync(storePath, JSON.stringify({ tickets: active }, null, 2));
    const before = readFileSync(storePath, 'utf8');
    const store = new LegacyTicketStore(storePath);

    assert.throws(
      () => store.write([ticket('A'), ticket('B')]),
      (error) => error.code === 'AMBIGUOUS_STORE_ROOT',
      'guessing the wrong repository is the failure — refuse instead',
    );
    assert.equal(readFileSync(storePath, 'utf8'), before, 'and nothing is written');

    // Told which repository it belongs to, it enforces THAT repository's contract.
    assert.throws(
      () => store.write([ticket('A'), ticket('B')], { root: repoRoot }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
    );
    assert.equal(readFileSync(storePath, 'utf8'), before, 'still untouched');

    store.write([ticket('A'), ticket('B')], { root: repoRoot, key: KEY });
    assert.equal(manifestEntries(repoRoot).some((entry) => entry.data.bypass === true), true,
      'and the override is recorded against the real repository');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

// `export` writes a snapshot wherever it is pointed. Pointed at the store — with a
// DIFFERENT source store selected — it replaces the ticket set, rails included,
// with no evidence that it happened.
test('store export REFUSES to write onto a ticket store, whichever store path it names', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-export-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    for (const target of [
      '.adlc/tickets.json',
      '.adlc/tickets.archive.json',
      '.adlc/tickets/anything.json',
      '.adlc/ticket-archive/anything.json',
      // The evidence ledger itself. Naming individual files invited exactly this
      // gap: an export over the append-only manifest destroys the audit history
      // this whole contract produces.
      '.adlc/manifest.jsonl',
      '.adlc/manifest.d/segment.jsonl',
      '.adlc/config.json',
    ]) {
      assert.throws(
        () => exportLegacyStore(store, target, { root }),
        (error) => error.code === 'UNSAFE_EXPORT_TARGET',
        `export onto ${target} must be refused`,
      );
      assert.equal(existsSync(join(root, target)), false, `and ${target} must not appear`);
    }
    // The hard-coded canonical layout is not the whole answer: a --ticket-store /
    // ADLC_TICKET_STORE pointing somewhere custom is still a store, and a legacy
    // `{ tickets }` envelope written over its .store.json marker leaves a directory
    // store unreadable while the command reports success.
    const custom = join(root, 'custom-store');
    writeDirectory(root, [ticket('C')]); // seeds .adlc/tickets; now make a custom one
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    const customStore = new DirectoryTicketStore(custom);
    const markerBefore = readFileSync(join(custom, '.store.json'), 'utf8');
    assert.throws(
      () => exportLegacyStore(customStore, 'custom-store/.store.json', { root }),
      (error) => error.code === 'UNSAFE_EXPORT_TARGET',
      'the SOURCE store is a store too',
    );
    assert.equal(readFileSync(join(custom, '.store.json'), 'utf8'), markerBefore, 'its marker is intact');

    // Somewhere outside the store is exactly what export is for — and it lands
    // relative to `root`, the same path the guard checked, not to process.cwd().
    const exported = exportLegacyStore(store, 'snapshot.json', { root });
    assert.equal(exported.hash, store.load().hash);
    assert.equal(existsSync(join(root, 'snapshot.json')), true, 'written where the guard looked');
    assert.equal(existsSync(join(process.cwd(), 'snapshot.json')), false, 'not relative to cwd');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The lexical check is not enough on its own: a symlinked parent directory names
// an innocent path that resolves into the store, and the rename follows the link.
test('store export refuses a path that only reaches a ticket store through a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-export-link-'));
  try {
    const path = writeDirectory(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    const store = new DirectoryTicketStore(path);
    mkdirSync(join(root, 'reports'), { recursive: true });
    symlinkSync(join(root, '.adlc', 'tickets'), join(root, 'reports', 'link'), 'dir');

    assert.throws(
      () => exportLegacyStore(store, 'reports/link/sneaky.json', { root }),
      (error) => error.code === 'UNSAFE_EXPORT_TARGET',
    );
    assert.equal(existsSync(join(root, '.adlc', 'tickets', 'sneaky.json')), false);

    // NESTED under a not-yet-existing directory: resolving only the immediate
    // parent would fail to resolve anything here and fall back to the innocent
    // lexical path, then the recursive mkdir would follow the link anyway.
    assert.throws(
      () => exportLegacyStore(store, 'reports/link/deeper/still/sneaky.json', { root }),
      (error) => error.code === 'UNSAFE_EXPORT_TARGET',
    );
    assert.equal(existsSync(join(root, '.adlc', 'tickets', 'deeper')), false, 'no directory was created inside the store');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The guard reserved `.adlc` and the SOURCE store. A repo driven with
// --ticket-store / ADLC_TICKET_STORE can have ANOTHER directory store somewhere
// else entirely, and that one is a trust root too — its `.store.json` marker and
// its shard directory are exactly as destroyable by a stray snapshot as the
// source's. Reserving only the store being read protects the wrong half.
test('store export refuses a destination inside a DIFFERENT directory store, not just the source', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-export-other-store-'));
  const otherRoot = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-export-store-b-'));
  try {
    const sourcePath = writeDirectory(root, [ticket('T-SOURCE')]);
    const store = new DirectoryTicketStore(sourcePath);

    // A second, unrelated directory store — outside this repo's `.adlc` entirely,
    // which is precisely what --ticket-store makes possible.
    const otherPath = writeDirectory(otherRoot, [ticket('T-OTHER', { rails: ['src/**'] })]);
    const marker = join(otherPath, '.store.json');
    const markerBefore = readFileSync(marker, 'utf8');
    const shardsBefore = readdirSync(otherPath).sort();

    // Straight onto the marker: it would become a legacy `{ tickets }` envelope and
    // the store would stop being loadable as the thing it is.
    assert.throws(
      () => exportLegacyStore(store, marker, { root }),
      (error) => error.code === 'UNSAFE_EXPORT_TARGET',
      'writing onto another store\'s marker is still writing onto a store',
    );
    assert.equal(readFileSync(marker, 'utf8'), markerBefore, 'the other store\'s marker is untouched');

    // And anywhere INSIDE it: a directory store enumerates its shards, so dropping
    // a foreign `{ tickets }` envelope in beside them corrupts the whole store, not
    // just one file.
    assert.throws(
      () => exportLegacyStore(store, join(otherPath, 'snapshot.json'), { root }),
      (error) => error.code === 'UNSAFE_EXPORT_TARGET',
    );
    assert.deepEqual(readdirSync(otherPath).sort(), shardsBefore, 'nothing was added to the other store');

    // The same argument for the other store SHAPE: a `.adlc` anywhere is some
    // repo's runtime and evidence area. The reservation knows only about this
    // root's, so another checkout's legacy store and ledger were writable too.
    const foreignLedger = join(otherRoot, '.adlc', 'manifest.jsonl');
    assert.throws(
      () => exportLegacyStore(store, foreignLedger, { root }),
      (error) => error.code === 'UNSAFE_EXPORT_TARGET',
      'another repo\'s evidence ledger is still an evidence ledger',
    );
    assert.equal(existsSync(foreignLedger), false, 'and it was not created');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

// The interrupted-then-resumed migration. Recovery REPLAYS the original apply
// entry, so that replay has to be byte-for-byte what the first run wrote — a
// different storeHashBefore turns a resumable recovery into a permanent
// EVIDENCE_IDEMPOTENCY_CONFLICT that no retry can clear.
test('recovering a migration that already recorded its apply evidence completes instead of conflicting', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-replay-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    // Crash AFTER the apply evidence is appended (the last fault point) so the
    // journal survives with the entry already in the manifest.
    assert.throws(() => migrateLegacyStore(root, {
      write: true, yes: true, requireClean: false, key: KEY,
      faultInjector(name) { if (name === 'gitignore-updated') throw new Error('fault'); },
    }), /fault/);
    const [id] = pendingTransactions(root);
    assert.ok(id, 'the crash left a recoverable migration');
    assert.equal(manifestEntries(root).filter((e) => e.data.action === 'apply').length, 1,
      'precondition: the apply evidence was already recorded');

    recoverMigration(root, id, { direction: 'complete', key: KEY });
    assert.deepEqual(pendingTransactions(root), [], 'the recovery completed and cleared the journal');
    const entries = manifestEntries(root);
    assert.equal(entries.filter((e) => e.data.action === 'apply').length, 1, 'the apply entry was not duplicated');
    const recovery = entries.find((e) => e.data.action === 'recover-complete');
    assert.ok(recovery, 'and the recovery has its own entry');
    assert.equal(recovery.data.bypass, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Rollback removes the directory archive BEFORE restoring the legacy archive
// backup. A crash in that window leaves a repo where nothing visible declares a
// rail, so the hash-verified archive BACKUP has to be part of the answer.
test('migration rollback still requires a key when only the ARCHIVE backup declares rails', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-archive-window-'));
  try {
    // The active store is rails-free; the rail lives in the legacy ARCHIVE.
    writeLegacy(root, [ticket('A')]);
    writeFileSync(
      join(root, '.adlc/tickets.archive.json'),
      `${JSON.stringify({ tickets: [ticket('OLD-RAILED', { rails: ['src/**'] })] }, null, 2)}\n`,
    );
    assert.throws(() => migrateLegacyStore(root, {
      write: true, yes: true, requireClean: false, key: KEY,
      faultInjector(name) { if (name === 'directory-renamed') throw new Error('fault'); },
    }), /fault/);
    const [id] = pendingTransactions(root);

    // Simulate the crash window: the directory archive is gone and the legacy one
    // has not been restored, so NOTHING visible in the repo declares a rail.
    rmSync(join(root, '.adlc/ticket-archive'), { recursive: true, force: true });
    rmSync(join(root, '.adlc/tickets.archive.json'), { force: true });
    assert.equal(repoDeclaresRails(root, [ticket('A')]), false, 'precondition: the repo looks rails-free');

    assert.throws(
      () => recoverMigration(root, id, { direction: 'rollback', key: null }),
      (error) => error.code === 'MANIFEST_KEY_REQUIRED',
      'the archive backup still says this is a trust root',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The idempotency scan decides whether a retry may SKIP writing evidence. If it
// ignores the audit payload, an entry that matches on gate and hashes but carries
// no `bypass`/`storeHashBefore` satisfies it, and the mutation finalizes as though
// it had been audited while the manifest holds no audit for it.
test('the idempotency scan does not accept a matching entry that lacks the audit payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-idem-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    const shared = {
      key: KEY, transactionId: 'tx-1', operation: 'create', ticketId: 'A',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), gate: 'ticket-mutation',
    };
    // An entry with the same identity and hashes but NO audit fields.
    recordTicketEvidence(root, shared);
    assert.equal(manifestEntries(root).length, 1);
    assert.equal(manifestEntries(root)[0].data.bypass, undefined);

    // The audited write of the same transaction must NOT be waved through by it.
    assert.throws(
      () => recordTicketEvidence(root, { ...shared, bypass: true, storeHashBefore: 'b'.repeat(64) }),
      (error) => error.code === 'EVIDENCE_IDEMPOTENCY_CONFLICT',
    );

    // A genuine retry of the SAME audited write is still idempotent.
    const audited = { ...shared, transactionId: 'tx-2', bypass: true, storeHashBefore: 'b'.repeat(64) };
    recordTicketEvidence(root, audited);
    recordTicketEvidence(root, audited);
    assert.equal(manifestEntries(root).filter((e) => e.data.transactionId === 'tx-2').length, 1);

    // ticketIds is part of the comparison too: a sweep that tombstoned a DIFFERENT
    // set of tickets is a different mutation, however identical the hashes look.
    const swept = { ...shared, transactionId: 'tx-3', bypass: true, storeHashBefore: 'b'.repeat(64), ticketIds: ['A'] };
    recordTicketEvidence(root, swept);
    recordTicketEvidence(root, swept); // same set → idempotent
    assert.equal(manifestEntries(root).filter((e) => e.data.transactionId === 'tx-3').length, 1);
    assert.throws(
      () => recordTicketEvidence(root, { ...swept, ticketIds: ['A', 'B'] }),
      (error) => error.code === 'EVIDENCE_IDEMPOTENCY_CONFLICT',
      'a different tombstoned set is different evidence',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// storeHashAfter is compared SEPARATELY from storeHash even though an honest
// writer sets them equal — because a forged entry need not. An attacker who can
// append picks both, so an entry whose storeHash matches the real transition
// while storeHashAfter names some other state must not pass as "already recorded".
test('an entry whose storeHashAfter disagrees with its own storeHash is not a match', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-idem-after-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    const honest = {
      key: null, transactionId: 'tx-1', operation: 'create', ticketId: 'A',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), gate: 'ticket-mutation',
      bypass: true, storeHashBefore: 'b'.repeat(64),
    };
    // Hand-place an entry that agrees on everything the older scan compared, but
    // whose own storeHashAfter names a state the store never reached.
    const forged = {
      seq: 1, gate: 'ticket-mutation', ts: '2026-01-01T00:00:00.000Z', ticket: 'A',
      data: {
        operation: 'create', action: 'apply', transactionId: 'tx-1', revision: null,
        ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), bindingScope: 'ticket',
        op: 'create', ticketId: 'A', storeHashBefore: 'b'.repeat(64),
        storeHashAfter: 'f'.repeat(64), bypass: true,
      },
      files: {}, prev: null,
    };
    writeFileSync(join(root, MANIFEST), `${JSON.stringify(forged)}\n`);

    assert.throws(
      () => recordTicketEvidence(root, honest),
      (error) => error.code === 'EVIDENCE_IDEMPOTENCY_CONFLICT',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A migration interrupted BEFORE this feature existed left an apply entry with no
// audit payload. Demanding one on the replay would make that recovery permanently
// unresolvable — it can neither complete nor roll back.
test('a migration whose apply evidence predates the audit fields can still be recovered', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-bypass-audit-legacy-evidence-'));
  try {
    writeLegacy(root, [ticket('T-RAILED', { rails: ['src/**'] })]);
    assert.throws(() => migrateLegacyStore(root, {
      write: true, yes: true, requireClean: false, key: KEY,
      faultInjector(name) { if (name === 'gitignore-updated') throw new Error('fault'); },
    }), /fault/);
    const [id] = pendingTransactions(root);

    // Age the recorded apply entry back to the pre-feature shape by stripping the
    // audit payload the older writer never produced — and RE-SIGN it, because a
    // genuine pre-feature entry was validly signed for its own content. Without
    // that the entry fails signature validation, gets skipped as absent, and the
    // legacy-match path this test exists for is never reached.
    const path = join(root, MANIFEST);
    const aged = readFileSync(path, 'utf8').trim().split('\n').map((line) => {
      const entry = JSON.parse(line);
      for (const field of ['bypass', 'op', 'ticketId', 'storeHashBefore', 'storeHashAfter', 'ticketIds']) {
        delete entry.data[field];
      }
      return JSON.stringify({ ...entry, sig: signV1(KEY, entry) });
    });
    writeFileSync(path, `${aged.join('\n')}\n`);
    assert.equal(manifestEntries(root).every((entry) => entry.data.bypass === undefined), true,
      'precondition: the recorded evidence carries no audit payload');

    recoverMigration(root, id, { direction: 'complete', key: KEY });
    assert.deepEqual(pendingTransactions(root), [], 'the recovery resolved instead of wedging');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the audit entry survives a canonical round trip: data is JSON-serializable and the signature covers it', () => {
  const root = repo([ticket('T-RAILED', { rails: ['src/**'] })]);
  try {
    runTicket(root, ['create', '--input', inputFile(root, newTicket('T-NEW')), '--write', '--json'], { ADLC_MANIFEST_KEY: KEY });
    const [entry] = manifestEntries(root);
    // Tampering with any audited field invalidates the signature.
    const tampered = { ...entry, data: { ...entry.data, storeHashBefore: '0'.repeat(64) } };
    assert.notEqual(signV1(KEY, tampered), entry.sig);
    assert.ok(canonicalJson(entry.data).includes('"bypass":true'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
