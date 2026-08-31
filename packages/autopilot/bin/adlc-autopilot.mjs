#!/usr/bin/env node
// @adlc/autopilot — the quota-gated local issue-to-PR loop (spec §13.0 grammar).
// Exit codes: 0 ok · 1 operational error · 2 a gate refused.

import { parseArgs, printJson } from '@adlc/core';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dispatch } from '../lib/cli.mjs';

const USAGE = `adlc-autopilot — quota-gated local issue-to-PR loop (also: adlc autopilot)

Usage:
  adlc-autopilot loop    [--rest DURATION] [--dry-run]
  adlc-autopilot once    [--issue N] [--force] [--dry-run] [--dry-run-shape]
  adlc-autopilot status  [--json]
  adlc-autopilot select  [--top N] [--json]
  adlc-autopilot quota   [--json] [--model M] [--quota-threshold T] [--quota-reserve R]
                         [--iteration ID] [--start-ordinal auto] [--wall-clock-remaining MIN]
  adlc-autopilot triage  --issue N [--json]
  adlc-autopilot reset   --issue N ( --confirm-delete OID [--delete-remote] | --attempts )
  adlc-autopilot init    [--labels] [--service] [--write]

Global operator-local flags: --repo OWNER/NAME (or ADLC_AUTOPILOT_REPO), --model, --adapter,
  --quota-threshold, --quota-reserve, --trusted-bin-dirs ABS-PATH-LIST, --ssh-identity ABS, --json
Exit codes: zero ok, one an operational error, two a gate refused.`;

export const OPTIONS = {
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'dry-run-shape': { type: 'boolean' },
  force: { type: 'boolean' },
  labels: { type: 'boolean' },
  service: { type: 'boolean' },
  write: { type: 'boolean' },
  'delete-remote': { type: 'boolean' },
  attempts: { type: 'boolean' },
  rest: { type: 'string' },
  issue: { type: 'string' },
  top: { type: 'string' },
  model: { type: 'string' },
  adapter: { type: 'string' },
  repo: { type: 'string' },
  'quota-threshold': { type: 'string' },
  'quota-reserve': { type: 'string' },
  'trusted-bin-dirs': { type: 'string' },
  'ssh-identity': { type: 'string' },
  'confirm-delete': { type: 'string' },
  iteration: { type: 'string' },
  'start-ordinal': { type: 'string' },
  'wall-clock-remaining': { type: 'string' },
  'max-rounds': { type: 'string' },
  'wall-clock-minutes': { type: 'string' },
  'max-open-prs': { type: 'string' },
  'rest-minutes': { type: 'string' },
  'ci-fix-rounds': { type: 'string' },
  'ci-watch-minutes': { type: 'string' },
};

export const SUBCOMMANDS = Object.freeze(['loop', 'once', 'status', 'select', 'quota', 'triage', 'reset', 'init']);

/** Parse argv (after the subcommand) into the flag object the library consumes. */
export function parseFlags(args) {
  const { values } = parseArgs({ args, options: OPTIONS, allowPositionals: false, usage: USAGE });
  return {
    json: values.json === true, dryRun: values['dry-run'] === true, dryRunShape: values['dry-run-shape'] === true,
    force: values.force === true, labels: values.labels === true, service: values.service === true, write: values.write === true,
    deleteRemote: values['delete-remote'] === true, attempts: values.attempts === true,
    rest: values.rest, issue: values.issue, top: values.top, model: values.model, adapter: values.adapter, repo: values.repo,
    quotaThreshold: values['quota-threshold'], quotaReserve: values['quota-reserve'], trustedBinDirs: values['trusted-bin-dirs'],
    sshIdentity: values['ssh-identity'], confirmDelete: values['confirm-delete'], iteration: values.iteration,
    startOrdinal: values['start-ordinal'], wallClockRemaining: values['wall-clock-remaining'],
    maxRounds: values['max-rounds'], wallClockMinutes: values['wall-clock-minutes'], maxOpenPrs: values['max-open-prs'],
    restMinutes: values['rest-minutes'], ciFixRounds: values['ci-fix-rounds'], ciWatchMinutes: values['ci-watch-minutes'],
  };
}

async function main() {
  const raw = process.argv.slice(2);
  const sub = raw[0];
  if (!sub || sub === '--help' || sub === '-h') { console.log(USAGE); process.exit(0); }
  if (!SUBCOMMANDS.includes(sub)) { console.error(`unknown subcommand: ${sub}\n\n${USAGE}`); process.exit(1); }
  let flags;
  try { flags = parseFlags(raw.slice(1)); } catch (e) { console.error(`adlc-autopilot: ${e.message}`); process.exit(1); }
  const result = await dispatch(sub, flags, { env: process.env, cwd: process.cwd() });
  if (flags.json && result.document !== undefined) printJson(result.document);
  else if (result.text) console.log(result.text);
  process.exit(result.exitCode ?? 0);
}

function entryUrl() {
  if (!process.argv[1]) return null;
  try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; }
}
if (entryUrl() === import.meta.url) main();
