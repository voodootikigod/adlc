// mutate-tickets-after-delay.mjs — test-only helper spawned as a real child
// process by run.test.mjs to simulate another writer (e.g. ticket-sync)
// mutating .adlc/tickets.json *while* ticket-prune is blocked retrying for
// the lock. Runs out-of-process so it isn't blocked by the synchronous
// Atomics.wait retry loop in store.mjs's acquireLock.
//
// argv: <dir> <ticketsJsonString> <delayMs>
// Behavior: sleep delayMs, then either overwrite <dir>/.adlc/tickets.json with
// the given contents OR — if ticketsJsonString is the literal sentinel
// "__DELETE__" — unlink the file entirely (to exercise the "ticket file
// disappeared under the lock" branch), then release the .adlc/tickets.lock the
// parent test pre-acquired.

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLock } from '../../lib/store.mjs';

const [, , dir, ticketsJson, delayMs] = process.argv;

await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));

const ticketsPath = join(dir, '.adlc', 'tickets.json');
if (ticketsJson === '__DELETE__') {
  rmSync(ticketsPath, { force: true });
} else {
  writeFileSync(ticketsPath, `${ticketsJson}\n`);
}

releaseLock(dir);
