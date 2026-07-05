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
import { computeDepthSignal, isDegraded, DEFAULT_DEPTH_THRESHOLD, DEFAULT_BYTES_THRESHOLD } from '../lib/depth-signal.mjs';
import { decideBuildGate } from '../lib/decide.mjs';
import { recordOverride } from '../lib/override.mjs';

const { values, positionals } = parseArgs({
  options: {
    depth: { type: 'string' },
    'session-bytes': { type: 'string' },
    transcript: { type: 'string' },
    'depth-threshold': { type: 'string', default: String(DEFAULT_DEPTH_THRESHOLD) },
    'bytes-threshold': { type: 'string', default: String(DEFAULT_BYTES_THRESHOLD) },
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
  --bytes-threshold <n>    default ${DEFAULT_BYTES_THRESHOLD}
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

let depth = 0;
let sessionBytes = 0;
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
}
if (values.depth !== undefined) depth = parseInt(values.depth, 10);
if (values['session-bytes'] !== undefined) sessionBytes = parseInt(values['session-bytes'], 10);

const { tier, signals } = computeRiskTier(ticket);
const degraded = isDegraded({ depth, sessionBytes, depthThreshold, bytesThreshold });
const bypass = process.env.ADLC_BUILD_GATE_BYPASS === '1';

const result = decideBuildGate({
  riskTier: tier,
  degraded,
  bypass,
  recordBypass: () =>
    recordOverride({
      ticketId: ticket.id,
      signals,
      depth,
      sessionBytes,
      reason: values.reason ?? 'ADLC_BUILD_GATE_BYPASS=1',
    }),
});

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
  decision: result.decision,
  reason: result.reason,
  overridden: result.overridden === true,
};

if (values.json) {
  printJson(output);
} else if (result.decision === 'deny') {
  console.error(`build-gate: DENY (${ticket.id}, risk=${tier}) — ${result.reason}`);
} else {
  console.log(`build-gate: allow (${ticket.id}, risk=${tier}) — ${result.reason}`);
}

process.exit(result.decision === 'deny' ? 2 : 0);
