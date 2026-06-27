#!/usr/bin/env node
// adlc ticket <pull|push|sync|doctor> — the external ticket-sync CLI.
// Dry-run by default; mutations require --write. Network lives only here + the
// provider; the pull logic itself is in lib/pull.mjs (offline-tested).

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { pull } from '../lib/pull.mjs';
import { makeGhRunner } from '../lib/gh.mjs';
import { githubProvider } from '../lib/providers/github.mjs';

const USAGE = `usage: adlc ticket <pull|push|sync|doctor> [--write] [--force] [--allow-rail-narrowing] [--json]

  pull    import issues from the external tracker into .adlc/tickets.json
  push    write ADLC tickets/outcomes back to the tracker        (T9 — not yet)
  sync    pull then push                                          (T9 — not yet)
  doctor  read-only health checks                                 (T10 — not yet)

Dry-run by default; pass --write to apply. Exit: 0 ok · 1 operational · 2 blocked.`;

export function parseFlags(args) {
  const flags = { write: false, force: false, 'allow-rail-narrowing': false, json: false };
  for (const a of args) {
    if (a === '--write') flags.write = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--allow-rail-narrowing') flags['allow-rail-narrowing'] = true;
    else if (a === '--json') flags.json = true;
    else { process.stderr.write(`unknown flag: ${a}\n`); process.exit(1); }
  }
  return flags;
}

function gitRemoteUrl() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function report(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.errors?.length) process.stderr.write(`${result.errors.map((e) => `  - ${e}`).join('\n')}\n`);
  if (result.plan?.length) {
    process.stdout.write(`${result.dryRun ? '[dry-run] would ' : ''}${result.applied ? 'applied' : 'plan'}:\n`);
    for (const p of result.plan) process.stdout.write(`  ${p.action}\t${p.id}${p.decision ? ` (${p.decision})` : ''}\n`);
  }
  if (result.dryRun) process.stdout.write('\nDry run — re-run with --write to apply.\n');
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === '--help' || sub === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(sub ? 0 : 1); }
  const flags = parseFlags(rest);

  if (sub === 'pull') {
    const result = await pull({
      dir: process.cwd(),
      provider: githubProvider(),
      runner: makeGhRunner(),
      gitRemoteUrl: gitRemoteUrl(),
      write: flags.write,
      force: flags.force,
      allowRailNarrowing: flags['allow-rail-narrowing'],
    });
    report(result, flags.json);
    process.exit(result.exitCode);
  }

  if (sub === 'push' || sub === 'sync' || sub === 'doctor') {
    process.stderr.write(`adlc ticket ${sub}: not implemented yet (${sub === 'doctor' ? 'T10' : 'T9'}).\n`);
    process.exit(1);
  }

  process.stderr.write(`unknown subcommand: ${sub}\n\n${USAGE}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`adlc ticket: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
