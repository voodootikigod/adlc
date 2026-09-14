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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL = join(REPO_ROOT, '.claude', 'skills', 'backlog-groom', 'SKILL.md');

/**
 * `gh` subcommands that change something on GitHub.
 *
 * A POSITIVE list of mutating verbs, not a denylist of forbidden strings: a
 * denylist is defeated by the next verb anyone invents, and this file's whole
 * job is to still be right about a wrapper nobody has written yet.
 */
const MUTATING = [
  'issue close', 'issue reopen', 'issue edit', 'issue comment', 'issue create', 'issue delete',
  'issue lock', 'issue unlock', 'issue pin', 'issue unpin', 'issue transfer',
  'label create', 'label edit', 'label delete',
  'pr close', 'pr merge', 'pr edit', 'pr comment', 'pr create', 'pr review',
  'api -X', 'api --method',
];

test('AC17: the shipped SKILL.md exists', () => {
  assert.ok(existsSync(SKILL), `${SKILL} must exist — the write path ships a wrapper`);
});

test('AC17: the shipped SKILL.md contains no mutating gh invocation', () => {
  const source = readFileSync(SKILL, 'utf8');
  // Normalise whitespace so `gh   issue    close` and a line-wrapped variant are
  // caught by the same check; a guard defeated by two spaces is not a guard.
  const flat = source.replace(/\s+/g, ' ');
  for (const verb of MUTATING) {
    assert.ok(
      !flat.includes(`gh ${verb}`),
      `SKILL.md invokes "gh ${verb}" — every GitHub write must flow through the core, or the floor, the gate and comment-first are all bypassed`
    );
  }
});

test('AC17: the guard would catch a mutation if one were added', () => {
  // A guard nobody has seen fail is a guard nobody knows works. This pins the
  // matcher itself against a synthetic wrapper, so a later "simplification" of
  // the normalisation cannot quietly make the real check vacuous.
  const hostile = 'Then run `gh   issue close $NUMBER` to finish up.';
  const flat = hostile.replace(/\s+/g, ' ');
  assert.ok(MUTATING.some((v) => flat.includes(`gh ${v}`)), 'the matcher must catch a whitespace-padded mutation');
});

test('AC17: the skill states the boundary it is bound by', () => {
  // The test enforces the rule; the skill has to TELL its reader the rule, or
  // the next author adds a mutation, sees a red test, and treats it as an
  // obstacle rather than a decision someone made.
  const source = readFileSync(SKILL, 'utf8');
  assert.match(source, /never (?:mutate|write)/i);
});
