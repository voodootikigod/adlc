#!/usr/bin/env node
// scaffold-cli.mjs — CLI wrapper around scaffold.mjs. Invoked by /adlc-init to
// bootstrap the Cursor integration into the target repo:
//
//   node lib/scaffold-cli.mjs <project-root>
//
// Idempotent; prints a human summary of what was created vs already present.

import { resolve } from 'node:path';
import { scaffold } from './scaffold.mjs';

const projectRoot = resolve(process.argv[2] ?? '.');
const { config, hooks, rule, gitignore, formatterIgnores } = scaffold(projectRoot);

const tag = (r) => (r.created ? 'created' : 'present');
console.log(`adlc-cursor scaffold (${projectRoot}):`);
console.log(`  .adlc/config.json     — ${tag(config)}`);
console.log(`  .cursor/hooks.json    — ${hooks.created ? 'created' : 'merged'} (rails-guard + audit wired)`);
if (hooks.backedUp) {
  console.log(`  ⚠ existing .cursor/hooks.json was unparseable — preserved verbatim at ${hooks.backedUp} before writing a fresh file`);
}
console.log(`  .cursor/rules/adlc.mdc — ${tag(rule)}`);
console.log(
  `  .gitignore             — ${gitignore.changed ? `updated (added ${gitignore.added.join(', ')})` : 'already tracks tickets.json + specs/'}`
);
for (const [tool, r] of Object.entries(formatterIgnores)) {
  if (!r.detected) continue;
  if (r.changed) console.log(`  ${tool} — excluded .adlc/ (${r.path})`);
  else if (r.skipped) console.log(`  ${tool} — detected but needs a manual .adlc/ ignore entry: ${r.skipped} (${r.path})`);
  else console.log(`  ${tool} — already excludes .adlc/`);
}
console.log('Next: author a ticket in .adlc/tickets.json, then `adlc rails-guard` to freeze rails.');
