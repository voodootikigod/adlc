#!/usr/bin/env node
// Renders a ticket inside a spawned split pane (t-herdr-3 ticket-show).
// Output is sanitized — ticket bodies are untrusted — and the pane waits for
// Enter so the content doesn't vanish when the process exits.
import { execFileSync } from 'node:child_process';
import { sanitize } from '../lib/sanitize.mjs';

const [repoRoot, ticketId] = process.argv.slice(2);
if (!repoRoot || !/^[A-Za-z0-9._-]+$/.test(ticketId ?? '')) {
  process.stderr.write('usage: show-ticket.mjs <repoRoot> <ticketId>\n');
  process.exit(1);
}

let output = '';
try {
  output = execFileSync('adlc', ['ticket', 'show', ticketId], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15_000, shell: false,
  });
} catch (error) {
  output = `could not read ticket ${ticketId}: ${error instanceof Error ? error.message : String(error)}`;
}

process.stdout.write(`${sanitize(output)}\n\n— press Enter to close —\n`);
process.stdin.once('data', () => process.exit(0));
process.stdin.resume();
