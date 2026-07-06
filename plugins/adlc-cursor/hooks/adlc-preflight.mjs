#!/usr/bin/env node
// adlc-preflight.mjs — once-per-session preflight for Cursor (T18).
// DISABLED BY DEFAULT.
//
// The Cursor `beforeSubmitPrompt` event is NOT pinned against current Cursor
// documentation (ADR 0006 pins only preToolUse / afterFileEdit /
// beforeShellExecution / beforeReadFile). Per the no-invented-events rule
// (cursor-native-parity spec decision 4), the scaffolder does NOT wire this
// script into .cursor/hooks.json unless explicitly opted in (scaffold option
// `wireUnpinned` / ADLC_CURSOR_WIRE_UNPINNED=1). The pinning TODO lives in
// ADR 0006.
//
// What it does (advisory only, never blocks, never throws): once per session
// (a TTL-scoped marker persisted under .adlc/ — Cursor payloads carry no
// pinned session id, so "session" is approximated by SESSION_TTL_MS of
// inactivity, same scoping as the buildgate depth counter), it runs
// `adlc preflight --json` and surfaces any warnings, plus the ADLC precedence
// assertion for repos that have opted into ADLC.

import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SESSION_TTL_MS, PREFLIGHT_MARKER_FILE } from '../constants.mjs';
import { candidateRoots } from './adlc-rails-guard.mjs';

// The precedence assertion (ADLC is the process spine; other process skills
// plug into its phases). Emitted whenever .adlc/ exists.
export const PRECEDENCE_ASSERTION =
  'ADLC precedence: route work through the ADLC gates; other process skills plug into phases.';

/**
 * Run the once-per-session preflight. Advisory only.
 * Returns { skipped, ran, notices: string[] }. `skipped` is true when the repo
 * is not ADLC-initialized or the session marker is still fresh.
 */
export function preflightOnce(root, {
  spawnImpl = spawnSync,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
} = {}) {
  const adlcDir = join(root, '.adlc');
  if (!existsSync(adlcDir)) return { skipped: true, ran: false, notices: [] };

  // Once per session: a fresh marker means this session already ran preflight.
  const marker = join(adlcDir, PREFLIGHT_MARKER_FILE);
  try {
    const data = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof data?.ts === 'number' && now - data.ts >= 0 && now - data.ts <= ttlMs) {
      return { skipped: true, ran: false, notices: [] };
    }
  } catch { /* missing/corrupt marker → run */ }

  const notices = [PRECEDENCE_ASSERTION];
  try {
    const r = spawnImpl('adlc', ['preflight', '--json'], { cwd: root, encoding: 'utf8' });
    if (r.error) {
      notices.push('`adlc` is not on PATH — install @adlc/cli (npm i -g @adlc/cli) before running gates.');
    } else if ((r.status ?? 1) !== 0) {
      notices.push(`adlc preflight reported problems: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
  } catch (err) {
    notices.push(`adlc preflight could not run: ${String(err).slice(0, 200)}`);
  }

  try {
    writeFileSync(marker, `${JSON.stringify({ ts: now })}\n`);
  } catch { /* advisory: a marker write failure just means we may run again */ }

  return { skipped: false, ran: true, notices };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch { /* advisory: ignore */ }
  }
  try {
    const root = candidateRoots(payload)[0] ?? process.cwd();
    const { notices } = preflightOnce(root);
    for (const n of notices ?? []) process.stderr.write(`adlc-preflight: ${n}\n`);
  } catch { /* advisory: never crash */ }
  // The beforeSubmitPrompt stdout contract is unpinned; emit a no-op object.
  process.stdout.write('{}');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
