#!/usr/bin/env node
// cli.mjs — the one-command bootstrap: `npx @adlc/opencode init` (T30).
//
// Wraps the same idempotent scaffold() the in-TUI /adlc-init command uses:
// creates .adlc/config.json, registers the plugin in .opencode/opencode.json
// (npm name when running from node_modules, resolved local path from a source
// checkout), deploys commands/agents/skills, and applies the .gitignore +
// formatter-ignore hygiene. Safe to re-run.
//
// Usage:
//   npx @adlc/opencode init [projectRoot]
//   npx @adlc/opencode --help

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scaffold } from '../lib/scaffold.mjs';

const USAGE = `usage: adlc-opencode init [projectRoot]

Bootstrap ADLC for OpenCode in the given project (default: cwd).
Idempotent — re-running refreshes commands/agents/skills from the package.

After it completes:
  1. npm install -g @adlc/cli   (if the \`adlc\` binary is not already on PATH)
  2. restart opencode — the rails-guard plugin loads from opencode.json`;

export function cliMain(argv = process.argv.slice(2)) {
  const [command = 'init', rootArg, ...extra] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command !== 'init') {
    console.error(`adlc-opencode: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  // Reject flag-looking roots and extra positionals instead of silently
  // scaffolding "./--dry-run" or ignoring arguments the user thought counted.
  if (rootArg?.startsWith('-')) {
    console.error(`adlc-opencode: unknown option "${rootArg}"\n\n${USAGE}`);
    return 1;
  }
  if (extra.length) {
    console.error(`adlc-opencode: unexpected argument(s): ${extra.join(' ')}\n\n${USAGE}`);
    return 1;
  }
  const projectRoot = resolve(process.cwd(), rootArg ?? '.');
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // package dir
  let r;
  try {
    r = scaffold(projectRoot, pkgRoot);
  } catch (err) {
    // Scaffold writes are idempotent — a re-run after fixing the cause repairs
    // any partial state. Surface a clean message, not a stack trace.
    console.error(`adlc-opencode init failed: ${err?.message ?? err}`);
    return 1;
  }
  console.log(`adlc-opencode init: ${projectRoot}`);
  console.log(`  config.json ${r.config.created ? 'created' : 'present'}`);
  console.log(`  plugin ${r.plugin.alreadyPresent ? 'already registered' : 'registered'} in .opencode/opencode.json`);
  console.log(`  ${r.commands.length} command(s), ${r.agents.length} agent(s), ${r.skills.length} skill(s) deployed`);
  if (r.deferredToClaudeSkills.length) {
    console.log(`  ${r.deferredToClaudeSkills.length} skill(s) deferred to existing .claude/skills/ copies (opencode discovers those)`);
  }
  console.log('\nNext: ensure `adlc` is installed (npm i -g @adlc/cli), then restart opencode.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(cliMain());
}
