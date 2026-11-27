#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs, printJson, opError, reasonList } from '@adlc/core';
import { assertPhase, requirementsForPhase, allPhases, allTracks, requiresTicket } from '../lib/assertions.mjs';
import { recordAcceptancePacket } from '../lib/acceptance.mjs';
import { evaluateTriage } from '../lib/triage.mjs';
import { scanRepositoryBloat } from '../lib/simplify.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const { values, positionals } = parseArgs({
  options: {
    dir: { type: 'string', default: '.adlc' },
    ticket: { type: 'string' },
    revision: { type: 'string' },
    track: { type: 'string' },
    'require-fresh-context': { type: 'boolean', default: false },
    base: { type: 'string', default: 'HEAD' },
    files: { type: 'string' },
    root: { type: 'string' },
    packet: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
  },
});

function help() {
  const phases = allPhases();
  const tracks = allTracks();
  const ticketRequired = phases.filter((p) => requiresTicket(p));
  console.log(`adlc-runner run <phase> [--dir .adlc] [--ticket id] [--revision rev] [--track track] [--require-fresh-context] [--json]
adlc-runner accept --ticket id --packet .adlc/packet.json [--before .adlc/before.json] [--after .adlc/after.json] [--dir .adlc] [--revision rev] [--json]
adlc-runner triage [--base HEAD] [--files a,b] [--dir .adlc] [--json]
adlc-runner simplify [--root .] [--json]
(or \`adlc run <phase> ...\` / \`adlc accept --ticket id ...\` / \`adlc triage ...\` / \`adlc simplify ...\` when @adlc/cli is installed)

Artifact-asserting ADLC phase runner, P0 triage classifier, and P7 simplify radar.

Phases: ${phases.join(' ')}
Tracks: ${tracks.join(' ')}
Ticket required: ${ticketRequired.join(' ')}
Revision required: trivial bounded p5 p6 use the current git worktree fingerprint unless --revision is supplied.
Explicit --revision selects recorded manifest/artifact evidence without live worktree comparison.

Exit codes:
  0  required phase evidence exists (or triage/simplify completed)
  1  operational error
  2  required phase evidence is missing or rejected
`);
}

if (values.version) {
  console.log(PKG.version);
  process.exit(0);
}

const verb = positionals[0];
const phase = positionals[1];

if (values.help) {
  if (verb === 'record') {
    console.log('adlc-runner record — record runner attestation evidence (reserved for signed runner pool)');
    process.exit(0);
  }
  if (verb === 'upgrade') {
    console.log('adlc-runner upgrade — upgrade runner binary/config (reserved for signed runner pool)');
    process.exit(0);
  }
  help();
  process.exit(0);
}
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
    opError(reasonList('P6 acceptance refused:', result.errors));
  }
  process.exit(result.exitCode);
}

if (verb === 'triage') {
  const fileList = values.files !== undefined
    ? values.files.split(',').map((f) => f.trim()).filter(Boolean)
    : undefined;
  let result;
  try {
    result = evaluateTriage({
      cwd: process.cwd(),
      base: values.base,
      files: fileList,
      dir: values.dir,
    });
  } catch (err) {
    opError(err.message);
  }
  if (values.json) {
    printJson(result);
  } else {
    console.log(`adlc triage: track=${result.track} (files=${result.changedFiles.length}, codeLines=${result.totalCodeLines}, partitions=${result.partitions.length})`);
    console.log(`  ticket required: ${result.ticketRequired}`);
    console.log(`  fresh context required: ${result.requireFreshContext}`);
    console.log(`  required gates: ${result.requiredGates.join(', ')}`);
  }
  process.exit(0);
}

if (verb === 'simplify') {
  let result;
  try {
    result = scanRepositoryBloat({ root: values.root ?? process.cwd() });
  } catch (err) {
    opError(err.message);
  }
  if (values.json) {
    printJson(result);
  } else {
    console.log(`adlc simplify: duplicateBlocks=${result.duplicateBlocks.length}, coreReinventions=${result.coreReinventions.length}`);
    for (const dup of result.duplicateBlocks) {
      const locs = dup.locations.map((l) => `${l.file}:${l.startLine}`).join(', ');
      console.log(`  duplicate (${dup.lineCount} lines): ${locs}`);
    }
    for (const item of result.coreReinventions) {
      console.log(`  core reinvention (${item.helper}): ${item.file}:${item.line}`);
    }
  }
  process.exit(0);
}

if (verb !== 'run' || !phase) {
  opError('usage: adlc-runner run <phase> [--dir .adlc] [--ticket id] [--json] (or adlc run <phase> ...)');
}

if (requirementsForPhase(phase) === null) {
  opError(`unknown phase: ${phase}`);
}

const result = assertPhase(phase, {
  dir: values.dir,
  ticket: values.ticket,
  revision: values.revision,
  key: getKey(),
  track: values.track,
  requireFreshContext: values['require-fresh-context'],
});
if (result.operational) {
  if (values.json) {
    printJson(result);
    process.exit(1);
  }
  opError(reasonList(`adlc ${phase}: cannot check evidence:`, result.errors));
}

if (values.json) {
  printJson(result);
} else if (result.ok) {
  console.log(`adlc ${phase}: required evidence present`);
} else if (Array.isArray(result.errors) && result.errors.length > 0) {
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
