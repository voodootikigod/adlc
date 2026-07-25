// The editor round-trip's compare-and-swap. Platform-neutral by construction:
// the editor is an injected JS callback, so this runs identically on the
// Windows leg of the ticket-store platform matrix, where a shebang shell
// fixture cannot be executed at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, TicketService, planEditSession } from '../index.mjs';
import { writeDirectory, ticket } from './helpers.mjs';

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-edit-'));
  try {
    writeDirectory(root, [ticket('T1', { title: 'original' })]);
    return fn(new TicketService(new DirectoryTicketStore(join(root, '.adlc/tickets')), { root }), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const edited = (title) => (_editor, path) => {
  writeFileSync(path, JSON.stringify({ ...ticket('T1', { title }) }, null, 2));
};

test('a quiet editor session plans an ordinary update', () => {
  withStore((service) => {
    const plan = planEditSession(service, 'T1', { editor: 'noop', runEditor: edited('my edit') });
    assert.equal(plan.ticketId, 'T1');
    assert.deepEqual(plan.changedFields, ['title']);
  });
});

test('a write during the editor session is caught as STALE_TICKET', () => {
  // The lost update: the hash was read AFTER the editor returned, so the
  // concurrent write became the "expected" version and this plan succeeded,
  // silently replacing it with a document derived from the original.
  withStore((service) => {
    const runEditor = (editor, path) => {
      // another author lands a write while the editor is "open"
      service.apply(service.planUpdate('T1', { ...ticket('T1', { title: 'concurrent' }) }, {
        expect: service.snapshot().ticketHashes.T1,
      }));
      edited('my edit')(editor, path);
    };
    assert.throws(
      () => planEditSession(service, 'T1', { editor: 'noop', runEditor }),
      (error) => error.code === 'STALE_TICKET',
    );
    assert.equal(service.snapshot().get('T1').title, 'concurrent', "the other author's write must survive");
  });
});

test('the editor sees the ticket as it stands, and the temp file is always removed', () => {
  withStore((service) => {
    let seen;
    let seenPath;
    planEditSession(service, 'T1', {
      editor: 'noop',
      runEditor: (_editor, path) => {
        seenPath = path;
        seen = JSON.parse(readFileSync(path, 'utf8'));
        edited('my edit')(_editor, path);
      },
    });
    assert.equal(seen.title, 'original');
    assert.throws(() => readFileSync(seenPath, 'utf8'), 'the temp file must not outlive the session');
  });
});

test('the temp file is removed even when the editor throws', () => {
  withStore((service) => {
    let seenPath;
    assert.throws(() => planEditSession(service, 'T1', {
      editor: 'noop',
      runEditor: (_editor, path) => { seenPath = path; throw new Error('editor died'); },
    }), /editor died/);
    assert.throws(() => readFileSync(seenPath, 'utf8'));
  });
});

test('an unset editor fails closed, and an unknown ticket fails before any temp file', () => {
  withStore((service) => {
    assert.throws(() => planEditSession(service, 'T1', { editor: undefined }), (error) => error.code === 'EDITOR_NOT_SET');
    assert.throws(() => planEditSession(service, 'nope', { editor: 'noop' }), (error) => error.code === 'TICKET_NOT_FOUND');
  });
});
