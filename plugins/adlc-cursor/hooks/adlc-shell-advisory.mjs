#!/usr/bin/env node
// adlc-shell-advisory.mjs — the Cursor `beforeShellExecution` hook (T18).
//
// beforeShellExecution is a PINNED Cursor event (ADR 0006). This hook NEVER
// denies — shell is Turing-complete and Bash-driven writes are intentionally
// not rail-gated in-session (ADR 0006 threat model; the CI rail-freeze gate is
// the control). It pattern-matches the command string for OBVIOUS writes
// targeting the active ticket's frozen rails or the ADLC trust roots
// (.adlc/tickets.json, .adlc/current-ticket.json) and, on a hit, emits an
// advisory agent_message reminding that the CI gate catches rail edits
// regardless of how they are made.
//
// HONESTY: this check is TRIVIALLY BYPASSABLE (variables, quoting, base64,
// scripts, interpreters — any indirection defeats a string match). It exists
// only to keep an honest agent honest; it is not a control and must never be
// described as one.

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { railPreconditions, TRUST_ROOT_RAILS } from '../rails-checker.mjs';
import { candidateRoots } from './adlc-rails-guard.mjs';
import { ticketStoreExists } from '@adlc/core';

// Field names the command string may arrive under. Cursor's docs name
// `command` for beforeShellExecution; the rest are defensive fallbacks (same
// discipline as the frozen guard's TOOL_NAME_KEYS — ADR 0006).
const COMMAND_KEYS = ['command', 'cmd', 'command_line', 'commandLine', 'script', 'shell_command', 'shellCommand', 'text'];

/** Best-effort command string from a beforeShellExecution payload. */
export function extractCommand(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const k of COMMAND_KEYS) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  // Some payloads nest the bag (tool_input-style) — one defensive level down.
  for (const bag of ['tool_input', 'toolInput', 'input']) {
    const b = payload[bag];
    if (b && typeof b === 'object') {
      for (const k of COMMAND_KEYS) {
        const v = b[k];
        if (typeof v === 'string' && v.trim()) return v;
      }
    }
  }
  return '';
}

// Obvious write indicators in a shell command: output redirection, in-place
// editors, and file-moving/removing utilities. Deliberately coarse — this is
// an advisory string match, not a parser.
const WRITE_INDICATOR_RE = /(?:>>?|\b(?:rm|mv|cp|tee|dd|truncate|touch|ln|install|rsync|shred|unlink)\b|\bsed\b[^|;&]*\s-[a-zA-Z]*i|\bperl\b[^|;&]*\s-[a-zA-Z]*i)/;

/**
 * The literal (wildcard-free) prefix of a rail glob, used for the substring
 * match — e.g. "packages/build-gate/**" → "packages/build-gate/". A glob with
 * no usable literal prefix is skipped (a bare "**" cannot be string-matched).
 */
function literalPrefix(glob) {
  const idx = glob.search(/[*?[\]{]/);
  const prefix = idx === -1 ? glob : glob.slice(0, idx);
  return prefix.length >= 3 ? prefix : null; // too-short prefixes over-match
}

/**
 * Advisory decision over a beforeShellExecution payload. ALWAYS allows.
 * Returns the Cursor verdict object: { permission: 'allow' } plus an
 * agent_message/user_message when the command obviously targets a rail or
 * trust root with a write.
 */
export function adviseShell(payload, { root, env = process.env } = {}) {
  try {
    const command = extractCommand(payload);
    if (!command) return { permission: 'allow' };

    const owningRoot = root ?? candidateRoots(payload)[0] ?? process.cwd();

    // Rail set: the active ticket's rails when enforcement is active; the
    // trust roots alone otherwise (they are worth flagging in any ADLC repo).
    let rails = [];
    const pre = railPreconditions({ root: owningRoot, env });
    if (pre.state === 'active') {
      rails = pre.rails;
    } else if (ticketStoreExists(owningRoot, env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null)) {
      rails = [...TRUST_ROOT_RAILS];
    } else {
      return { permission: 'allow' }; // not an ADLC repo → nothing to advise on
    }

    if (!WRITE_INDICATOR_RE.test(command)) return { permission: 'allow' };

    const hits = [];
    for (const rail of rails) {
      const prefix = literalPrefix(rail);
      if (prefix && command.includes(prefix)) hits.push(rail);
    }
    if (!hits.length) return { permission: 'allow' };

    const list = [...new Set(hits)].join(', ');
    return {
      permission: 'allow', // NEVER deny — advisory by design
      user_message: `ADLC shell advisory: this command appears to write to a frozen rail / trust root (${list}).`,
      agent_message:
        `ADVISORY (not a block): this shell command looks like it writes to an ADLC frozen rail or ` +
        `trust root (${list}). Shell writes are not rail-gated in-session. The commit-time CI ` +
        `rail-freeze gate catches rail edits regardless of how they were made, but only for rails ` +
        `ALREADY FROZEN ON THE BASE BRANCH — a rail first declared on this branch and edited in the ` +
        `same PR is NOT caught until it lands on base (see ADR-0006 "Known scope limit"). If the rail ` +
        `must change, update the ticket spec and re-freeze instead.`,
    };
  } catch {
    return { permission: 'allow' }; // advisory: never fail closed, never throw
  }
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
  process.stdout.write(JSON.stringify(adviseShell(payload, { env: process.env })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
