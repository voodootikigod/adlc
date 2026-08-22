#!/usr/bin/env node
import { parseArgs, printJson, opError } from '@adlc/core';
import { assertPhase, requirementsForPhase, allPhases, requiresTicket } from '../lib/assertions.mjs';
import { recordAcceptancePacket } from '../lib/acceptance.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

const { values, positionals } = parseArgs({
  options: {
    dir: { type: 'string', default: '.adlc' },
    ticket: { type: 'string' },
    revision: { type: 'string' },
    packet: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

function help() {
  const phases = allPhases();
  const ticketRequired = phases.filter((p) => requiresTicket(p));
  console.log(`adlc run <phase> [--dir .adlc] [--ticket id] [--revision rev] [--json]
adlc accept --ticket id --packet .adlc/packet.json [--before .adlc/before.json] [--after .adlc/after.json] [--dir .adlc] [--revision rev] [--json]

Artifact-asserting ADLC phase runner.

Phases: ${phases.join(' ')}
Ticket required: ${ticketRequired.join(' ')}
Revision required: p5 p6 use the current git worktree fingerprint unless --revision is supplied.
Explicit --revision selects recorded manifest/artifact evidence without live worktree comparison.

Exit codes:
  0  required phase evidence exists
  1  operational error
  2  required phase evidence is missing
`);
}

if (values.help) {
  help();
  process.exit(0);
}

const verb = positionals[0];
const phase = positionals[1];
if (verb === 'accept') {
  const result = recordAcceptancePacket({
    key: getKey(),
    dir: values.dir,
    ticket: values.ticket,
    packet: values.packet,
    before: values.before,
    after: values.after,
    revision: values.revision,
  });
  if (values.json) {
    printJson(result);
  } else if (result.ok) {
    console.log(`adlc accept: recorded P6 acceptance packet for ${result.ticket}`);
  } else {
    opError(result.errors.join('; '));
  }
  process.exit(result.exitCode);
}

if (verb !== 'run' || !phase) {
  opError('usage: adlc run <phase> [--dir .adlc] [--ticket id] [--json]');
}

if (requirementsForPhase(phase) === null) {
  opError(`unknown phase: ${phase}`);
}

const result = assertPhase(phase, { dir: values.dir, ticket: values.ticket, revision: values.revision });
if (result.operational) opError(result.errors.join('; '));

if (values.json) {
  printJson(result);
} else if (result.ok) {
  console.log(`adlc ${phase}: required evidence present`);
} else if (Array.isArray(result.errors)) {
  // A content-level gate failure (stale/incomplete/contradictory evidence,
  // e.g. p0/p1's integrity checks) — a normal exit-2 rejection with reasons,
  // not the "evidence missing entirely" shape below.
  console.error(`adlc ${phase}: evidence rejected:\n  ${result.errors.join('\n  ')}`);
} else {
  // `skipped` carries two unlike failures in one channel: the own-chain
  // IDENTITY refusal ("we cannot establish which evidence is ours", which also
  // arrives as `identityError`) and manifest lines that would not parse.
  // Counting them together told every detached-HEAD checkout — the state
  // actions/checkout leaves a PR build in — that its ledger was malformed,
  // while the one sentence naming the actual cause sat unread in the channel.
  // Printed before the missing list because it is why that list is empty.
  if (result.identityError) console.error(`adlc ${phase}: ${result.identityError}`);
  console.error(`adlc ${phase}: missing evidence: ${result.missing.join(', ') || 'none'}`);
  const malformed = result.skipped.filter((entry) => entry.error !== result.identityError);
  if (malformed.length > 0) {
    console.error(`malformed manifest lines: ${malformed.length}`);
    for (const entry of malformed) {
      // A rejected segment FILE is skipped with `line: null` — there is no
      // position to name, so the locator degrades to the segment rather than
      // printing an empty one.
      const at = [entry.segment, entry.line].filter((part) => part !== null && part !== undefined).join(':');
      console.error(`  ${at}: ${entry.error}`);
    }
  }
}

process.exit(result.ok ? 0 : 2);
