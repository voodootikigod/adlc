#!/usr/bin/env node
import { parseArgs, printJson, opError } from '@adlc/core';
import { assertPhase, requirementsForPhase } from '../lib/assertions.mjs';
import { recordAcceptancePacket } from '../lib/acceptance.mjs';

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
  console.log(`adlc run <phase> [--dir .adlc] [--ticket id] [--revision rev] [--json]
adlc accept --ticket id --packet .adlc/packet.json [--before .adlc/before.json] [--after .adlc/after.json] [--dir .adlc] [--revision rev] [--json]

Artifact-asserting ADLC phase runner.

Phases: p1 p2 p3 p4 p5 p6 p7
Ticket required: p3 p4 p5 p6
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
} else {
  console.error(`adlc ${phase}: missing evidence: ${result.missing.join(', ') || 'none'}`);
  if (result.skipped.length > 0) console.error(`malformed manifest lines: ${result.skipped.length}`);
}

process.exit(result.ok ? 0 : 2);
