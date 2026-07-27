// The editor round-trip's compare-and-swap. Platform-neutral by construction:
// the editor is an injected JS callback, so this runs identically on the
// Windows leg of the ticket-store platform matrix, where a shebang shell
// fixture cannot be executed at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    const { plan, draftPath } = planEditSession(service, 'T1', { editor: 'noop', runEditor: edited('my edit') });
    assert.equal(plan.ticketId, 'T1');
    assert.deepEqual(plan.changedFields, ['title']);
    // The draft OUTLIVES planning: `edit` is dry-run by default, so deleting it
    // here destroyed the author's only copy on the commonest invocation.
    assert.equal(JSON.parse(readFileSync(draftPath, 'utf8')).title, 'my edit');
    rmSync(draftPath, { force: true });
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

test('the editor sees the ticket as it stands, and the draft survives planning', () => {
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
    assert.ok(readFileSync(seenPath, 'utf8').length > 0, 'the draft outlives the session — only an APPLY may remove it');
    rmSync(seenPath, { force: true });
  });
});

test('an editor that dies leaves the draft behind, not a deleted one', () => {
  // This test previously asserted the opposite — that the temp file is removed
  // on failure. That was the data-loss behavior: whatever the author had
  // written when their editor crashed was deleted for them. Cleanup on the
  // SUCCESS path only; a failure keeps the file and names it.
  withStore((service) => {
    let seenPath;
    assert.throws(() => planEditSession(service, 'T1', {
      editor: 'noop',
      runEditor: (_editor, path) => { seenPath = path; throw new Error('editor died'); },
    }), /editor died/);
    assert.ok(readFileSync(seenPath, 'utf8').length > 0, 'the draft must survive an editor crash');
    rmSync(seenPath, { force: true });
  });
});

test('an unset editor fails closed, and an unknown ticket fails before any temp file', () => {
  withStore((service) => {
    assert.throws(() => planEditSession(service, 'T1', { editor: undefined }), (error) => error.code === 'EDITOR_NOT_SET');
    assert.throws(() => planEditSession(service, 'nope', { editor: 'noop' }), (error) => error.code === 'TICKET_NOT_FOUND');
  });
});

test('a failed plan preserves the edit and says where it is', () => {
  // Planning fails for reasons the author cannot predict and did not cause —
  // most often STALE_TICKET, which the compare-and-swap makes MORE likely, not
  // less. Deleting the editor session's work in a `finally` turned a
  // recoverable conflict into lost effort.
  withStore((service) => {
    const runEditor = (_editor, path) => {
      service.apply(service.planUpdate('T1', { ...ticket('T1', { title: 'concurrent' }) }, {
        expect: service.snapshot().ticketHashes.T1,
      }));
      writeFileSync(path, JSON.stringify(ticket('T1', { title: 'my careful edit' }), null, 2));
    };
    let message = '';
    assert.throws(() => planEditSession(service, 'T1', { editor: 'noop', runEditor }), (error) => {
      message = error.message;
      return error.code === 'STALE_TICKET';
    });
    const preserved = message.match(/preserved at (\S+?)\)/)?.[1];
    assert.ok(preserved, `the error must name the draft path: ${message}`);
    assert.equal(JSON.parse(readFileSync(preserved, 'utf8')).title, 'my careful edit');
    rmSync(preserved, { force: true });
  });
});

test('planning never deletes the draft — that is the caller decision', () => {
  // Cleanup moved to the CLI, which removes the draft only after a successful
  // apply. A library that deletes on successful PLANNING cannot tell a dry run
  // from a write, and `edit` without --write is the default.
  withStore((service) => {
    let seen;
    const { draftPath } = planEditSession(service, 'T1', {
      editor: 'noop',
      runEditor: (_e, path) => { seen = path; writeFileSync(path, JSON.stringify(ticket('T1', { title: 'ok' }))); },
    });
    assert.equal(draftPath, seen);
    assert.equal(JSON.parse(readFileSync(draftPath, 'utf8')).title, 'ok');
    rmSync(draftPath, { force: true });
  });
});

test('an edit across an authorization boundary is refused unless the caller authorized it', () => {
  // planEditSession forwards `authorized` to planUpdate, and its DEFAULT is
  // closed. Nothing asserted that: every test above edits a title, which is not
  // sensitive, so opening the default changed no result — and `adlc ticket edit`
  // without --authorize would have been able to complete a ticket, narrow its
  // rails or widen its scope with no evidence, simply because the author typed
  // it into their editor.
  withStore((service) => {
    const completes = (_editor, path) => {
      writeFileSync(path, JSON.stringify(ticket('T1', { title: 'original', completed: true }), null, 2));
    };
    let message = '';
    assert.throws(
      () => planEditSession(service, 'T1', { editor: 'noop', runEditor: completes }),
      (error) => {
        message = error.message;
        return error.code === 'AUTHORIZATION_REQUIRED';
      },
      'the default must be closed: an unauthorized edit cannot cross the lifecycle boundary',
    );
    rmSync(message.match(/preserved at (\S+?)\)/)?.[1] ?? '', { force: true });

    // …and the same edit goes through once the caller says so, so the refusal
    // above is the authorization check and not the edit being rejected outright.
    const { plan, draftPath } = planEditSession(service, 'T1', {
      editor: 'noop',
      runEditor: completes,
      authorized: true,
    });
    assert.deepEqual(plan.sensitive, ['lifecycle-change']);
    rmSync(draftPath, { force: true });
  });
});

test('an unset editor leaves no temp directory and claims no preserved edit', () => {
  // The check ran AFTER mkdtemp, so every attempt without $EDITOR left a
  // directory in /tmp and reported "your edit is preserved at ..." for a session
  // in which no editing occurred. Preserving work is only meaningful when work
  // exists; saying so otherwise trains people to ignore the message.
  withStore((service) => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('adlc-ticket-edit-')).length;
    let raised;
    assert.throws(() => planEditSession(service, 'T1', { editor: undefined }), (error) => {
      raised = error;
      return error.code === 'EDITOR_NOT_SET';
    });
    assert.doesNotMatch(raised.message, /preserved at/, 'there was no edit to preserve');
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('adlc-ticket-edit-')).length;
    assert.equal(after, before, 'and no temp directory may be left behind');
  });
});
