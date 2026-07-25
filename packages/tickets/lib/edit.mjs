// The $EDITOR round-trip, lifted out of bin/ so the concurrency guarantee it
// makes is testable without spawning a real editor. A shell-script fixture
// would not run on the Windows leg of the ticket-store platform matrix, and an
// untested compare-and-swap is how the lost update below survived in the first
// place.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { TicketStoreError } from './errors.mjs';

/** Default runner: hand the temp file to $EDITOR and wait. */
export const spawnEditor = (editor, path) => execFileSync(editor, [path], { stdio: 'inherit' });

/**
 * Plan an editor session as an update.
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
  const directory = mkdtempSync(join(tmpdir(), 'adlc-ticket-edit-'));
  const path = join(directory, `${basename(id)}.json`);
  try {
    writeFileSync(path, `${JSON.stringify(ticket, null, 2)}\n`);
    if (!editor) throw new TicketStoreError('operational', 'EDITOR_NOT_SET', 'set $EDITOR or $VISUAL');
    runEditor(editor, path);
    const edited = JSON.parse(readFileSync(path, 'utf8'));
    // The edited document never leaves this function otherwise, so a caller
    // that wants to inspect what the human actually wrote (the CLI warns about
    // a category ticket-sync cannot round-trip) needs a hook rather than
    // reaching into the plan's private state.
    onEdited?.(edited);
    return service.planUpdate(ticket.id, edited, { expect, authorized });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
