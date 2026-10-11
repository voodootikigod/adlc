#!/usr/bin/env node
// build-gate — ADLC C13 fitness-to-build gate (issue #48). Thin CLI: parse
// args, call lib, exit with the correct code.
//
// Denies STARTING a high-risk ticket's P4 build when the executing session's
// context-fitness signal is past threshold, unless an audited override is
// recorded (mirrors the ADLC_RAILS_BYPASS pattern — see rails-guard/
// adlc-hook.mjs). A CLI process can't observe its own caller's context state;
// the caller (a hook, CI wrapper, or any Path-A harness) supplies the signal
// via --depth/--session-bytes, or a --transcript file to derive it from.

import { readFileSync, existsSync } from 'node:fs';
import { parseArgs, opError, printJson, loadTickets, ADLC_DIR } from '@adlc/core';
import { computeRiskTier } from '../lib/risk.mjs';
import { computeDepthSignal, classifyTranscriptSignal, isDegraded, DEFAULT_DEPTH_THRESHOLD } from '../lib/depth-signal.mjs';
import { decideBuildGate } from '../lib/decide.mjs';
import { recordOverride } from '../lib/override.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

/**
 * The CLI's own `--bytes-threshold` default. `../lib/depth-signal.mjs`'s
 * own DEFAULT_BYTES_THRESHOLD currently equals HARD_BYTES (256 KiB); a raw
 * byte count alone does not indicate tool-call depth, so a threshold that
 * low classifies an ordinary session with zero tool calls as degraded. This
 * override is scoped to the flag default only — `isDegraded` itself takes
 * an explicit `bytesThreshold`, so nothing about the library's own contract
 * or behavior changes; only what this binary asks for when the caller
 * doesn't say otherwise.
 */
const CLI_DEFAULT_BYTES_THRESHOLD = 8 * 1024 * 1024;

const { values, positionals } = parseArgs({
  options: {
    depth: { type: 'string' },
    'session-bytes': { type: 'string' },
    transcript: { type: 'string' },
    'depth-threshold': { type: 'string', default: String(DEFAULT_DEPTH_THRESHOLD) },
    'bytes-threshold': { type: 'string', default: String(CLI_DEFAULT_BYTES_THRESHOLD) },
    tickets: { type: 'string' },
    reason: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`build-gate <ticket-id> [options]

Machine-checkable fitness-to-build gate (ADLC C13 / P3→P4 entry gate).
Denies STARTING a high-risk ticket's build when the executing session's
context-fitness signal (transcript depth/bytes) is past threshold, unless an
audited override is recorded.

Arguments:
  <ticket-id>              Ticket to gate (required)

Options:
  --depth <n>              Precomputed tool-call-count depth signal
  --session-bytes <n>      Precomputed transcript byte-size signal
  --transcript <path>      Derive depth/session-bytes from this transcript file
                           (a --depth/--session-bytes passed alongside it wins)
  --depth-threshold <n>    default ${DEFAULT_DEPTH_THRESHOLD}
  --bytes-threshold <n>    default ${CLI_DEFAULT_BYTES_THRESHOLD}
  --tickets <path>         default .adlc/tickets.json
  --reason <text>          Free-text reason recorded with an override
  --json                   Machine-readable JSON output
  --help                   Show this help

Neither --depth/--session-bytes nor --transcript supplied → the signal
defaults to "not degraded" (a gate that received no signal cannot deny).

Override:
  Set ADLC_BUILD_GATE_BYPASS=1 to deliberately override a deny. The override
  is recorded to .adlc/manifest.jsonl as a 'build-gate-bypass' entry — an
  override that cannot be durably recorded is refused (never a silent bypass).

Exit codes:
  0  allow (gate passes)
  1  operational error (bad ticket id, missing tickets file, bad thresholds)
  2  deny (gate fails)

ADLC phase: P3 → P4 entry gate (C13)
`);
  process.exit(0);
}

const ticketId = positionals[0];
if (!ticketId) {
  opError('usage: build-gate <ticket-id> [options] (use --help for details)');
}

const ticketsPath = values.tickets ?? `${ADLC_DIR}/tickets.json`;
const { tickets, errors } = loadTickets(ticketsPath);
if (errors.length > 0 && tickets.length === 0) {
  opError(`could not load tickets from ${ticketsPath}: ${errors[0]}`);
}
const ticket = tickets.find((t) => t.id === ticketId);
if (!ticket) {
  opError(`ticket "${ticketId}" not found in ${ticketsPath}`);
}

const depthThreshold = parseInt(values['depth-threshold'], 10);
if (!Number.isInteger(depthThreshold) || depthThreshold < 0) {
  opError('--depth-threshold must be a non-negative integer');
}
const bytesThreshold = parseInt(values['bytes-threshold'], 10);
if (!Number.isInteger(bytesThreshold) || bytesThreshold < 0) {
  opError('--bytes-threshold must be a non-negative integer');
}
if (values.depth !== undefined && !/^\d+$/.test(values.depth)) {
  opError('--depth must be a non-negative integer');
}
if (values['session-bytes'] !== undefined && !/^\d+$/.test(values['session-bytes'])) {
  opError('--session-bytes must be a non-negative integer');
}

// Where the signal came from — reported on every result so a caller can tell
// "measured, fresh" from "measured nothing" (issue #588):
//   flags             --depth and/or --session-bytes were given (they win over a transcript)
//   transcript        derived from a transcript with at least one recognizable tool call
//   transcript-empty  a transcript was given but yielded zero tool calls
//   none              no signal was supplied at all (defaults to not degraded)
let depth = 0;
let sessionBytes = 0;
let signalSource = 'none';
if (values.transcript !== undefined) {
  if (!existsSync(values.transcript)) {
    opError(`transcript file not found: ${values.transcript}`);
  }
  let text;
  try {
    text = readFileSync(values.transcript, 'utf8');
  } catch (err) {
    opError(`could not read transcript: ${err.message}`);
  }
  const sig = computeDepthSignal({ text });
  depth = sig.depth;
  sessionBytes = sig.bytes;
  signalSource = classifyTranscriptSignal(sig) === 'measured' ? 'transcript' : 'transcript-empty';
}
if (values.depth !== undefined) depth = parseInt(values.depth, 10);
if (values['session-bytes'] !== undefined) sessionBytes = parseInt(values['session-bytes'], 10);
if (values.depth !== undefined || values['session-bytes'] !== undefined) signalSource = 'flags';

const { tier, signals } = computeRiskTier(ticket);

// A transcript that measured nothing is "could not measure", not "fresh". For a
// high-risk ticket that is an operational error — the gate was asked to
// measure the session and cannot — matching the hook path's rule that an
// unverifiable session must not be allowed through (build-gate-fitness.md,
// Known limitations). A ticket the gate does not guard is still allowed, but
// the reason says so rather than claiming a measurement.
if (signalSource === 'transcript-empty' && tier === 'high') {
  opError(
    `could not derive a context signal from ${values.transcript}: no recognizable tool calls ` +
    '(empty, truncated, compacted, or an unrecognized transcript format) — ' +
    'refusing to treat an unmeasured session as fresh'
  );
}

const degraded = isDegraded({ depth, sessionBytes, depthThreshold, bytesThreshold });
const bypass = process.env.ADLC_BUILD_GATE_BYPASS === '1';

const result = decideBuildGate({
  riskTier: tier,
  degraded,
  bypass,
  recordBypass: () =>
    recordOverride({
      key: getKey(),
      ticketId: ticket.id,
      signals,
      depth,
      sessionBytes,
      reason: values.reason ?? 'ADLC_BUILD_GATE_BYPASS=1',
    }),
});

// Only a non-high-risk ticket reaches here with an empty transcript; its allow
// stands (the gate guards nothing for it) but the reason must not claim a
// measurement that never happened.
const reason = signalSource === 'transcript-empty'
  ? 'no context signal could be derived from the transcript; the ticket is not high-risk so nothing is gated'
  : result.reason;

const output = {
  tool: 'build-gate',
  ticket: ticket.id,
  riskTier: tier,
  signals,
  depth,
  sessionBytes,
  depthThreshold,
  bytesThreshold,
  degraded,
  signalSource,
  decision: result.decision,
  reason,
  overridden: result.overridden === true,
};

if (values.json) {
  printJson(output);
} else if (result.decision === 'deny') {
  console.error(`build-gate: DENY (${ticket.id}, risk=${tier}) — ${reason} [signal: ${signalSource}]`);
} else {
  console.log(`build-gate: allow (${ticket.id}, risk=${tier}) — ${reason} [signal: ${signalSource}]`);
}

process.exit(result.decision === 'deny' ? 2 : 0);
