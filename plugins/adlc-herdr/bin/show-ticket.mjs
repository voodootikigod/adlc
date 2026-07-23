#!/usr/bin/env node
// Renders a ticket inside a spawned split pane (t-herdr-3 ticket-show).
// Output is sanitized — ticket bodies are untrusted — and the pane waits for
// Enter so the content doesn't vanish when the process exits.
import { execFileSync } from 'node:child_process';
import { sanitize } from '../lib/sanitize.mjs';

const [repoRoot, ticketId] = process.argv.slice(2);
// Reject a leading hyphen: `adlc` does not honor a `--` end-of-options
// separator (verified), so a `-`-leading id would reach it as an option
// (CWE-88). The dispatcher validates too; this is the redundant second gate.
if (!repoRoot || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(ticketId ?? '')) {
  process.stderr.write('usage: show-ticket.mjs <repoRoot> <ticketId>\n');
  process.exit(1);
}

let output = '';
try {
  output = execFileSync('adlc', ['ticket', 'show', ticketId], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15_000, shell: false,
  });
} catch (error) {
  // Surface the CLI's own stderr/stdout — execFileSync's error.message is only
  // a generic "Command failed", so the real reason (e.g. a malformed store)
  // would otherwise be discarded.
  const detail = [error?.stderr, error?.stdout, error?.message]
    .map((part) => (part == null ? '' : String(part).trim()))
    .filter(Boolean)
    .join(' — ');
  output = `could not read ticket ${ticketId}: ${detail || 'unknown error'}`;
}

process.stdout.write(`${sanitize(output)}\n\n— press Enter to close —\n`);
process.stdin.once('data', () => process.exit(0));
process.stdin.resume();
