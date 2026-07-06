#!/usr/bin/env node
// scaffold-cli.mjs — CLI wrapper around scaffold.mjs. Invoked by /adlc-init to
// bootstrap the Cursor integration into the target repo:
//
//   node lib/scaffold-cli.mjs <project-root>
//
// Idempotent; prints a human summary of what was created vs already present.

import { resolve } from 'node:path';
import { scaffold } from './scaffold.mjs';

// --wire-unpinned (or ADLC_CURSOR_WIRE_UNPINNED=1): ALSO wire the UNPINNED
// `stop` / `beforeSubmitPrompt` events to the disabled-by-default stop-audit /
// preflight hooks. Off by default — those events are not verified against
// Cursor documentation (ADR 0006).
const args = process.argv.slice(2);
const wireUnpinned = args.includes('--wire-unpinned') || process.env.ADLC_CURSOR_WIRE_UNPINNED === '1';
const projectRoot = resolve(args.filter((a) => !a.startsWith('--'))[0] ?? '.');
const { config, hooks, rule, commands, gitignore, formatterIgnores } = scaffold(projectRoot, { wireUnpinned });

const tag = (r) => (r.created ? 'created' : 'present');
console.log(`adlc-cursor scaffold (${projectRoot}):`);
console.log(`  .adlc/config.json     — ${tag(config)}`);
console.log(`  .cursor/hooks.json    — ${hooks.created ? 'created' : 'merged'} (preToolUse dispatcher + audit + shell advisory wired${wireUnpinned ? ' + UNPINNED stop/beforeSubmitPrompt (opt-in)' : ''})`);
if (hooks.backedUp) {
  console.log(`  ⚠ existing .cursor/hooks.json was unparseable — preserved verbatim at ${hooks.backedUp} before writing a fresh file`);
}
console.log(`  .cursor/rules/adlc.mdc — ${tag(rule)}`);
console.log(`  .cursor/commands/      — deployed ${commands.length} command(s): ${commands.join(', ')}`);
const gitignoreStatus = gitignore.changed
  ? gitignore.added.length > 0
    ? `updated (added ${gitignore.added.join(', ')})`
    : 'updated (repaired duplicate/misplaced entries)'
  : 'already tracks tickets.json + specs/';
console.log(`  .gitignore             — ${gitignoreStatus}`);
const logToolLine = (name, r) => {
  if (r.changed) console.log(`  ${name} — excluded .adlc/ (${r.path})`);
  else if (r.skipped) console.log(`  ${name} — detected but needs a manual .adlc/ ignore entry: ${r.skipped} (${r.path})`);
  else console.log(`  ${name} — already excludes .adlc/`);
};
for (const [tool, r] of Object.entries(formatterIgnores)) {
  if (!r.detected) continue;
  // `eslint` may cover both `.eslintrc*` and `.eslintignore` at once when a
  // repo has both — report each source file individually so neither
  // mutation is dropped from the summary.
  if (r.sources) {
    for (const sr of Object.values(r.sources)) {
      if (sr.detected) logToolLine(tool, sr);
    }
    continue;
  }
  logToolLine(tool, r);
}
console.log('Next: author a ticket in .adlc/tickets.json, then `adlc rails-guard` to freeze rails.');
