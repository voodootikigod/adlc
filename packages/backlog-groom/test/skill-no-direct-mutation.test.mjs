// skill-no-direct-mutation.test.mjs — AC17.
//
// A single `gh issue close` in the wrapper bypasses the floor, the gate and the
// comment-first rule in one call — structurally the same gap as rails-guard's
// un-gated Bash surface. The skill is prose, so nothing at runtime stops it;
// this test is the enforcement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mutatingGhInvocations } from './gh-mutation-matcher.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL = join(REPO_ROOT, '.claude', 'skills', 'backlog-groom', 'SKILL.md');

test('AC17: the shipped SKILL.md exists', () => {
  assert.ok(existsSync(SKILL), `${SKILL} must exist — the write path ships a wrapper`);
});

test('AC17: the shipped SKILL.md contains no mutating gh invocation', () => {
  // The matcher parses each invocation (persistent flags before the subcommand,
  // the API method after the endpoint, fields as an implicit POST) after
  // collapsing whitespace, so padding or line-wrapping does not hide one.
  const found = mutatingGhInvocations(readFileSync(SKILL, 'utf8'));
  assert.deepEqual(
    found,
    [],
    `SKILL.md invokes ${found.join('; ')} — every GitHub write must flow through the core, or the floor, the gate and comment-first are all bypassed`
  );
});

test('AC17: the guard would catch a mutation if one were added', () => {
  // A guard nobody has seen fail is a guard nobody knows works. The shapes a
  // literal substring check misses are pinned in skill-mutation-matcher.test.mjs.
  const hostile = 'Then run `gh   issue --repo o/r close $NUMBER` and `gh api repos/o/r/issues/7/comments -f body=x`.';
  assert.equal(mutatingGhInvocations(hostile).length, 2);
});

test('AC17: the skill states the boundary it is bound by', () => {
  // The test enforces the rule; the skill has to TELL its reader the rule, or
  // the next author adds a mutation, sees a red test, and treats it as an
  // obstacle rather than a decision someone made.
  const source = readFileSync(SKILL, 'utf8');
  assert.match(source, /never (?:mutate|write)/i);
});
