// The editor round-trip's compare-and-swap. Platform-neutral by construction:
// the editor is an injected JS callback, so this runs identically on the
// Windows leg of the ticket-store platform matrix, where a shebang shell
// fixture cannot be executed at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

/**
 * Remove the whole mkdtemp directory a draft lives in, not just the draft file.
 *
 * Cleaning up only the file stranded one directory under $TMPDIR per session —
 * six per run of this file — against a package that claims its tests leave no
 * trace. Guarded twice, because a recursive remove deserves both:
 *
 *  - an unset path means the session failed BEFORE the runner was reached, and
 *    rmSync(undefined) raises a TypeError that would replace the real failure
 *    with a confusing one;
 *  - the directory must be one planEditSession actually minted. Today every
 *    draft lives alone inside its own mkdtemp, so dirname() is always safe —
 *    but that is an invariant of code this file does not own, and if a draft
 *    ever moved to a shared directory this cleanup would silently become a
 *    recursive delete of it. Assert the invariant instead of assuming it.
 */
function discardDraft(path) {
  if (!path) return;
  const directory = dirname(path);
  assert.ok(
    basename(directory).startsWith('adlc-ticket-edit-'),
    `refusing to recursively remove ${directory}: not a draft session directory`,
  );
  rmSync(directory, { recursive: true, force: true });
}

test('a quiet editor session plans an ordinary update', () => {
  withStore((service) => {
    const { plan, draftPath } = planEditSession(service, 'T1', { editor: 'noop', runEditor: edited('my edit') });
    assert.equal(plan.ticketId, 'T1');
    assert.deepEqual(plan.changedFields, ['title']);
    // The draft OUTLIVES planning: `edit` is dry-run by default, so deleting it
    // here destroyed the author's only copy on the commonest invocation.
    assert.equal(JSON.parse(readFileSync(draftPath, 'utf8')).title, 'my edit');
    discardDraft(draftPath);
  });
});

test('a write during the editor session is caught as STALE_TICKET', () => {
  // The lost update: the hash was read AFTER the editor returned, so the
  // concurrent write became the "expected" version and this plan succeeded,
  // silently replacing it with a document derived from the original.
  withStore((service) => {
    let draftPath;
    const runEditor = (editor, path) => {
      draftPath = path;
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
    discardDraft(draftPath);
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
    discardDraft(seenPath);
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
    discardDraft(seenPath);
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
    discardDraft(preserved);
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
    discardDraft(draftPath);
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
    // The draft path comes from the runner, which is handed it directly. Parsing
    // it back out of the error message would depend on that prose AND on the
    // path containing no whitespace — and a tmpdir with a space in it would
    // yield a truncated prefix pointing at somebody's parent directory.
    let draft;
    const completes = (_editor, path) => {
      draft = path;
      writeFileSync(path, JSON.stringify(ticket('T1', { title: 'original', completed: true }), null, 2));
    };
    // Both halves below run the SAME runner, so the draft is cleared between
    // them: without that, a second session that failed before writing would let
    // the first one's stale path be discarded twice. Runs from `finally` so a
    // failed assertion leaks nothing either.
    const discardThisDraft = () => { discardDraft(draft); draft = undefined; };

    try {
      assert.throws(
        () => planEditSession(service, 'T1', { editor: 'noop', runEditor: completes }),
        (error) => error.code === 'AUTHORIZATION_REQUIRED',
        'the default must be closed: an unauthorized edit cannot cross the lifecycle boundary',
      );
    } finally { discardThisDraft(); }

    // …and the same edit goes through once the caller says so, so the refusal
    // above is the authorization check and not the edit being rejected outright.
    try {
      const { plan } = planEditSession(service, 'T1', {
        editor: 'noop',
        runEditor: completes,
        authorized: true,
      });
      assert.deepEqual(plan.sensitive, ['lifecycle-change']);
    } finally { discardThisDraft(); }
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
