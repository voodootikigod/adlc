import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Issue #62(b): the in-session PreToolUse hook fails OPEN on a non-zero exit.
// This is already documented in SKILL.md and the hook shim, but wasn't surfaced
// anywhere more visible -- an operator skimming install docs could assume the
// hook is a hard block. These tests pin that visibility so it can't silently
// regress back to "buried SKILL.md line only".

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

function section(markdown, heading) {
  // Extract the body of a level-2 (##) markdown section up to the next ## heading.
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  assert.ok(startIdx !== -1, `heading "${heading}" not found`);
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^## /.test(l));
  return (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n');
}

test('antigravity.md Install section foregrounds the fail-open risk near the top', () => {
  const doc = readFileSync(
    join(REPO_ROOT, 'docs', 'integrations', 'antigravity.md'),
    'utf8'
  );
  const install = section(doc, '## Install');
  assert.match(
    install,
    /fail(s)?\s*\*{0,2}open/i,
    'Install section should state the hook fails OPEN'
  );
  assert.match(
    install,
    /CI\b.*(backstop|real (guarantee|control))|(backstop|real (guarantee|control)).*CI\b/is,
    'Install section should name CI as the real backstop'
  );
});

test('antigravity.md Install section callout appears before the install commands, not buried after them', () => {
  const doc = readFileSync(
    join(REPO_ROOT, 'docs', 'integrations', 'antigravity.md'),
    'utf8'
  );
  const install = section(doc, '## Install');
  const calloutIdx = install.search(/fail(s)?\s*\*{0,2}open/i);
  const firstCommandIdx = install.indexOf('agy plugin install');
  assert.ok(calloutIdx !== -1, 'callout not found');
  assert.ok(firstCommandIdx !== -1, 'install command not found');
  assert.ok(
    calloutIdx < firstCommandIdx,
    'fail-open callout should appear before the first install command, i.e. near the top'
  );
});

test('the Antigravity plugin points at scripts/rails-guard-ci.mjs as a required-check recommendation', () => {
  // plugins/adlc-antigravity has no README.md (matches the rest of the plugins/
  // directory, none of which have one) -- commands/adlc-init.md is the closest
  // equivalent (it is the plugin's own install/bootstrap doc).
  const initDoc = readFileSync(
    join(REPO_ROOT, 'plugins', 'adlc-antigravity', 'commands', 'adlc-init.md'),
    'utf8'
  );
  assert.match(
    initDoc,
    /scripts\/rails-guard-ci\.mjs/,
    'adlc-init.md should link scripts/rails-guard-ci.mjs by path'
  );
  assert.match(
    initDoc,
    /required check/i,
    'the rails-guard-ci.mjs reference should be framed as a required-check recommendation'
  );
});
