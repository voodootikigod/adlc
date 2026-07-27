// The $EDITOR round-trip, lifted out of bin/ so the concurrency guarantee it
// makes is testable without spawning a real editor. A shell-script fixture
// would not run on the Windows leg of the ticket-store platform matrix, and an
// untested compare-and-swap is how the lost update below survived in the first
// place.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { TicketStoreError } from './errors.mjs';

/** Default runner: hand the temp file to $EDITOR and wait. */
export const spawnEditor = (editor, path) => execFileSync(editor, [path], { stdio: 'inherit' });

/**
 * Plan an editor session as an update. Returns { plan, draftPath }: the draft
 * outlives this call so the CALLER can delete it once the plan is applied — a
 * dry run must not destroy the work it is previewing.
 *
 * The expected hash is bound to the ticket we OPEN, before the editor runs.
 * Reading it afterwards made any write that landed during the session — which
 * is arbitrarily long — the "expected" version, so the compare-and-swap passed
 * on a document derived from the older one and dropped the other author's work.
 */
export function planEditSession(service, id, { authorized = false, editor, runEditor = spawnEditor, onEdited } = {}) {
  const opened = service.snapshot();
  const ticket = opened.get(id);
  if (!ticket) throw new TicketStoreError('invalid', 'TICKET_NOT_FOUND', `ticket not found: ${id}`);
  const expect = opened.ticketHashes[ticket.id];
  // Check $EDITOR BEFORE creating anything. This ran after mkdtemp, so a user
  // with no $EDITOR got a temp directory left behind on every attempt AND an
  // error claiming "your edit is preserved at ..." — for a session in which no
  // editing happened. Preserving work is only meaningful when work exists.
  if (!editor) throw new TicketStoreError('operational', 'EDITOR_NOT_SET', 'set $EDITOR or $VISUAL');
  const directory = mkdtempSync(join(tmpdir(), 'adlc-ticket-edit-'));
  const path = join(directory, `${basename(id)}.json`);
  try {
    writeFileSync(path, `${JSON.stringify(ticket, null, 2)}\n`);
    runEditor(editor, path);
    const edited = JSON.parse(readFileSync(path, 'utf8'));
    // The edited document never leaves this function otherwise, so a caller
    // that wants to inspect what the human actually wrote (the CLI warns about
    // a category ticket-sync cannot round-trip) needs a hook rather than
    // reaching into the plan's private state.
    onEdited?.(edited);
    const plan = service.planUpdate(ticket.id, edited, { expect, authorized });
    // Deliberately NOT deleted here. Planning succeeding is not the same as the
    // edit being SAVED: `adlc ticket edit T1` is dry-run by default, so the
    // common path plans fine, prints the plan, applies nothing — and deleting
    // the draft at this point threw away the author's work on the invocation
    // they are most likely to run. The caller owns the draft now, and only a
    // successful apply should remove it.
    return { plan, draftPath: path };
  } catch (error) {
    // KEEP the draft. Planning fails for reasons the author cannot predict and
    // did not cause — most often STALE_TICKET, which the compare-and-swap makes
    // MORE likely, not less — and deleting their editor session's work in a
    // `finally` turned a recoverable conflict into lost effort. The path goes in
    // the message because an error naming no path is the same as no draft.
    if (error && typeof error.message === 'string') {
      error.message = `${error.message} (your edit is preserved at ${path})`;
    }
    throw error;
  }
}
