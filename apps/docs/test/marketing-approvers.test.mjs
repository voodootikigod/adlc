// marketing-approvers.test.mjs — every machine approver the site displays must
// be a tool the dispatcher actually routes.
//
// The approval chain tells the visitor these are executable: the whole claim of
// the page is that the lifecycle runs in CI rather than living in a wiki. A name
// that does not dispatch is therefore a broken promise, not a cosmetic typo.
//
// This is a regression test for a real defect. P4 shipped as `adlc gate`, which
// does not exist — `packages/gate` is not a package and the dispatcher exits 1
// on it. The name had been lifted from an MCP tool called `adlc_gate`, which is
// not a CLI. An adversarial review caught it; nothing in the suite would have.
//
// The check reads the dispatcher's own tool list rather than executing each
// tool, because some tools (lesson-foundry) legitimately have no `--help` and
// running them for real would need repository state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(docsRoot, '../..');
const dispatcher = path.join(repoRoot, 'packages/cli/bin/adlc.mjs');

/** The tool names `adlc --help` advertises, parsed from its grouped listing. */
function dispatcherTools() {
  const help = execFileSync(process.execPath, [dispatcher, '--help'], { encoding: 'utf8' });
  const tools = new Set();
  for (const line of help.split('\n')) {
    // Tool rows are indented four spaces: "    spec-lint    Gate specs for ..."
    const match = /^ {4}([a-z][a-z0-9-]*) {2,}\S/.exec(line);
    if (match) tools.add(match[1]);
  }
  return tools;
}

/** The `adlc <tool>` names rendered in the approval chain's approver column. */
function displayedApprovers() {
  const source = readFileSync(
    path.join(docsRoot, 'components/marketing/lifecycle-pipeline.tsx'),
    'utf8',
  );
  const block = /export const APPROVER: Record<string, string> = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'the APPROVER map must remain a statically readable literal');
  return [...block[1].matchAll(/'adlc ([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
}

test('the dispatcher advertises a non-trivial tool list', () => {
  // Guards the parser: if the help format changes and this returns nothing, the
  // assertion below would pass vacuously against an empty set.
  const tools = dispatcherTools();
  assert.ok(tools.size >= 20, `expected the dispatcher to list its tools, parsed ${tools.size}`);
});

test('every machine approver shown on the site is a real dispatchable tool', () => {
  const tools = dispatcherTools();
  const approvers = displayedApprovers();

  assert.ok(approvers.length > 0, 'the approval chain must display at least one machine approver');

  for (const tool of approvers) {
    assert.ok(
      tools.has(tool),
      `the approval chain shows "adlc ${tool}", which the dispatcher does not route.\n` +
        `  Known tools: ${[...tools].sort().join(', ')}`,
    );
  }
});

test('the guard itself detects a planted unknown tool (self-test)', () => {
  const tools = dispatcherTools();
  assert.ok(!tools.has('gate'), '"gate" must not be a routed tool — it is the defect this guards');
});
