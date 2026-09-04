#!/usr/bin/env node
import { HARNESS_GUESS_WARNING_PREFIX, KNOWN_HARNESSES, scaffold } from '../lib/scaffold.mjs';

function usage() {
  console.log(`adlc init [--root <path>] [--json] [--no-codex-agents] [--harness <${KNOWN_HARNESSES.join('|')}>]

Idempotently creates the committable .adlc runtime and optional project-scoped
Codex agents. --harness cursor and --harness copilot each imply --no-codex-agents
and record harnesses.<name> in a fresh config; --harness copilot also scaffolds a
.github/copilot-instructions.md block and a copilot-setup-steps.yml snippet. With
no --harness at all, the config registers "codex" as a guess and warns — pass the
harness you actually use explicitly to avoid the guess.
Writes are confined to --root; never edits user-global harness configuration
implicitly.`);
}

function parse(argv) {
  const options = { root: '.', json: false, codexAgents: true, harness: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true, ...options };
    if (arg === '--json') options.json = true;
    else if (arg === '--no-codex-agents') options.codexAgents = false;
    else if (arg === '--harness') {
      if (index + 1 >= argv.length) throw new Error('--harness requires a value');
      const value = argv[++index];
      if (!KNOWN_HARNESSES.includes(value)) {
        throw new Error(`--harness must be one of ${KNOWN_HARNESSES.join(', ')} (got ${value})`);
      }
      options.harness = value;
      if (value === 'cursor' || value === 'copilot') options.codexAgents = false;
    } else if (arg === '--root') {
      if (index + 1 >= argv.length) throw new Error('--root requires a path');
      options.root = argv[++index];
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) usage();
  else {
    const result = scaffold(options);
    // Warnings mark a store left in a broken/ambiguous state — never report
    // unqualified success for those, so automation keying off ok/exit
    // notices. The harness-guess advisory is the one documented exception:
    // it lives in `result.warnings` too (the single, --json-visible
    // contract), but does not itself fail the run — bare `adlc init`, the
    // single most common invocation, must stay exit 0 by default.
    const hardWarnings = result.warnings.filter((w) => !w.startsWith(HARNESS_GUESS_WARNING_PREFIX));
    const ok = hardWarnings.length === 0;
    if (options.json) console.log(JSON.stringify({ ok, ...result }, null, 2));
    else {
      console.log(`ADLC initialized at ${result.root}`);
      for (const path of result.created) console.log(`  created ${path}`);
      for (const path of result.updated) console.log(`  updated ${path}`);
      for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
      if (result.created.length === 0 && result.updated.length === 0 && result.warnings.length === 0) console.log('  already current');
    }
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(`adlc-init: ${error.message}`);
  process.exitCode = 1;
}
