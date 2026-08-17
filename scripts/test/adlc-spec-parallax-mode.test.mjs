// adlc-spec-parallax-mode.test.mjs — cross-harness regression gate.
//
// Codex cross-model review (adversarial-review, feat/p1-interrogation round
// 9): four harnesses' /adlc-spec step 1 documented
// `adlc parallax --file <spec-or-request> ...` even though the command's own
// argument-hint says the target is a ticket id or rough request, never an
// existing file — parallax --file rejects a nonexistent path, so following
// the documented workflow literally with a ticket id or free-text request
// fails before the interrogation loop begins. Fixed by resolving the target
// to request text first and invoking parallax with --request instead. This
// test lives outside any single package (like flag-consistency.test.mjs)
// because it asserts a cross-cutting doc contract, not one tool's behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILES = [
  'plugins/adlc-claude-code/commands/adlc-spec.md',
  'plugins/adlc-cursor/command/adlc-spec.md',
  'plugins/adlc-opencode/command/adlc-spec.md',
  'plugins/adlc-pi/prompts/adlc-spec.md',
];

for (const rel of FILES) {
  test(`${rel}: step 1 resolves the target to request text and uses parallax --request, not --file`, () => {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(
      text,
      /parallax --file <spec-or-request>/,
      'the target (a ticket id or rough request, never an existing file at this step) must not be passed to parallax --file'
    );
    assert.match(
      text,
      /parallax --request/,
      'step 1 must invoke parallax --request with the resolved text'
    );
  });
}
