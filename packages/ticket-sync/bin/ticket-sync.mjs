#!/usr/bin/env node
// adlc ticket <pull|push|sync|doctor> — the external ticket-sync CLI.
// Dry-run by default; mutations require --write. Network lives only here + the
// provider; the pull logic itself is in lib/pull.mjs (offline-tested).

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pull } from '../lib/pull.mjs';
import { push } from '../lib/push.mjs';
import { doctor } from '../lib/doctor.mjs';
import { makeGhRunner } from '../lib/gh.mjs';
import { githubProvider } from '../lib/providers/github.mjs';
import { resolveKeyFromEnv } from '@adlc/tickets/lib/key-contract.mjs';

const USAGE = `usage: adlc ticket <pull|push|sync|doctor> [--write] [--force] [--allow-rail-narrowing] [--allow-unsigned] [--json]

  pull    import issues from the external tracker into .adlc/tickets.json
  push    write ADLC tickets/outcomes back to the tracker (update + idempotent create)
  sync    pull then push
  doctor  read-only offline health checks (config/tickets/schema/sidecar/lock)

Dry-run by default; pass --write to apply. Exit: 0 ok · 1 operational · 2 blocked.

Once any ticket declares a rail the store is a frozen trust root: a --write against
it records a signed audit entry and needs ADLC_MANIFEST_KEY. --allow-unsigned
records that entry unsigned instead, deliberately.
`;

export function parseFlags(args) {
  const flags = { write: false, force: false, 'allow-rail-narrowing': false, 'allow-unsigned': false, json: false, help: false };
  for (const a of args) {
    if (a === '--write') flags.write = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--allow-rail-narrowing') flags['allow-rail-narrowing'] = true;
    else if (a === '--allow-unsigned') flags['allow-unsigned'] = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--archive') {} // retained for store-doctor CLI compatibility
    // `adlc ticket <pull|push|sync|doctor>` routes here, so this is the parser a
    // user reaches when they follow `adlc ticket <command> --help`. Rejecting
    // --help as an unknown flag made that instruction a dead end for four of the
    // documented commands.
    else if (a === '--help' || a === '-h') flags.help = true;
    else { process.stderr.write(`unknown flag: ${a}\n`); process.exit(1); }
  }
  return flags;
}

/**
 * sync = pull then push, composed. A non-clean pull (conflict/operational) ABORTS
 * before push — never push on top of an unreconciled pull. Pure orchestration over
 * injected pull/push thunks so the abort branch is unit-testable offline.
 */
export async function syncFlow(pullFn, pushFn) {
  const pulled = await pullFn();
  if (pulled.exitCode !== 0) return { exitCode: pulled.exitCode, pulled, pushed: null };
  const pushed = await pushFn();
  return { exitCode: pushed.exitCode, pulled, pushed };
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
    for (const p of result.plan) {
      const detail = p.decision ? ` (${p.decision})` : p.newId ? ` -> ${p.newId}` : p.reason ? ` (${p.reason})` : '';
      process.stdout.write(`  ${p.action ?? p.kind}\t${p.id}${detail}\n`);
    }
  }
  if (result.dryRun) process.stdout.write('\nDry run — re-run with --write to apply.\n');
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === '--help' || sub === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(sub ? 0 : 1); }
  const flags = parseFlags(rest);
  if (flags.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

  if (sub === 'pull') {
    const result = await pull({
      dir: process.cwd(),
      provider: githubProvider(),
      runner: makeGhRunner(),
      gitRemoteUrl: gitRemoteUrl(),
      key: resolveKeyFromEnv(),
      allowUnsigned: Boolean(flags['allow-unsigned']),
      write: flags.write,
      force: flags.force,
      allowRailNarrowing: flags['allow-rail-narrowing'],
    });
    report(result, flags.json);
    process.exit(result.exitCode);
  }

  if (sub === 'push') {
    const result = await push({
      dir: process.cwd(),
      provider: githubProvider(),
      key: resolveKeyFromEnv(),
      allowUnsigned: Boolean(flags['allow-unsigned']),
      runner: makeGhRunner(),
      gitRemoteUrl: gitRemoteUrl(),
      write: flags.write,
    });
    report(result, flags.json);
    process.exit(result.exitCode);
  }

  if (sub === 'sync') {
    const common = {
      dir: process.cwd(), provider: githubProvider(), runner: makeGhRunner(), gitRemoteUrl: gitRemoteUrl(),
      key: resolveKeyFromEnv(), allowUnsigned: Boolean(flags['allow-unsigned']),
    };
    const { exitCode, pulled, pushed } = await syncFlow(
      () => pull({ ...common, write: flags.write, force: flags.force, allowRailNarrowing: flags['allow-rail-narrowing'] }),
      () => push({ ...common, write: flags.write }),
    );
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ pull: pulled, push: pushed })}\n`);
    } else {
      process.stdout.write('— pull —\n'); report(pulled, false);
      if (pushed) { process.stdout.write('— push —\n'); report(pushed, false); }
    }
    process.exit(exitCode);
  }

  if (sub === 'doctor') {
    const result = doctor({ dir: process.cwd(), key: resolveKeyFromEnv() });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      for (const c of result.checks) {
        process.stdout.write(`  ${c.ok ? 'ok  ' : 'FAIL'}\t${c.name}${c.detail ? `\t— ${c.detail}` : ''}\n`);
      }
      process.stdout.write(`\n${result.ok ? 'All checks passed.' : 'Problems found — see FAIL rows above.'}\n`);
    }
    process.exit(result.exitCode);
  }

  process.stderr.write(`unknown subcommand: ${sub}\n\n${USAGE}\n`);
  process.exit(1);
}

// The file:// URL of the script Node was started with, symlinks resolved — npm's
// .bin entries are symlinks, so argv[1] is the link while import.meta.url is the
// real file (#786) — or null when there is no resolvable entry: a bare `node -e`
// import has no argv[1], and a nonexistent argv[1] cannot be realpath'd.
function entryUrl() {
  if (!process.argv[1]) return null;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
}

if (entryUrl() === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`adlc ticket: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
