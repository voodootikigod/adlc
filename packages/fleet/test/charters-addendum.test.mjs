// fleet-ext item 6 (`--charter-file`): the addendum is appended AFTER the
// Constraints block so the constraints keep their authority over it — the same
// rule the fenced specification is already under. AC7 of the fleet-extensions
// ticket: ordering asserted by index, and the constraints text unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderPrompt, fixPrompt, fenceDeadEnd, DEAD_END_MAX_CHARS } from '../lib/charters.mjs';

const ticket = { id: 'T9', title: 'do the thing', body: 'spec body', scope: ['packages/x/**'], rails: ['packages/y/lib/z.mjs'] };
const gate = { build: 'npm run build', test: 'npm test' };
const CONSTRAINTS_HEADING = '## Constraints (non-negotiable)';

function constraintsSlice(prompt) {
  const start = prompt.indexOf(CONSTRAINTS_HEADING);
  assert.ok(start >= 0, 'the Constraints heading is present');
  // The block ends where the closing "Run the gate commands" paragraph (or the
  // addendum heading) begins — whichever comes first after the heading.
  const ends = ['\n\n## Charter addendum', '\n\nRun the gate commands'].map((m) => prompt.indexOf(m, start)).filter((i) => i >= 0);
  return prompt.slice(start, Math.min(...ends));
}

test('the addendum appears AFTER the Constraints block (index order) and the constraints text is byte-identical', () => {
  const plain = builderPrompt(ticket, gate);
  const withAddendum = builderPrompt(ticket, gate, { addendum: 'Follow /adlc:adlc P3–P5 before TICKET-DONE.' });
  const constraintsAt = withAddendum.indexOf(CONSTRAINTS_HEADING);
  const addendumAt = withAddendum.indexOf('## Charter addendum');
  assert.ok(constraintsAt >= 0 && addendumAt > constraintsAt, `addendum (${addendumAt}) must follow constraints (${constraintsAt})`);
  assert.ok(withAddendum.indexOf('Follow /adlc:adlc P3–P5') > addendumAt, 'the addendum text sits under its heading');
  assert.equal(constraintsSlice(withAddendum), constraintsSlice(plain), 'the Constraints block is unchanged by an addendum');
  // The stop condition still closes the prompt — the addendum cannot become the last word.
  assert.ok(withAddendum.lastIndexOf('TICKET-BLOCKED') > addendumAt, 'the stop condition follows the addendum');
  assert.ok(!plain.includes('## Charter addendum'), 'no addendum → no heading (byte-identical legacy prompt)');
});

test('the fix prompt inherits the addendum and keeps dead-end material AFTER it, fenced as untrusted', () => {
  const p = fixPrompt(ticket, gate, ['log 1'], { addendum: 'ADDENDUM-TEXT' });
  const a = p.indexOf('ADDENDUM-TEXT');
  const d = p.indexOf('PRIOR_ATTEMPT_1');
  assert.ok(a > 0 && d > a, 'addendum precedes the fenced prior attempts');
  assert.match(p, /UNTRUSTED output/);
});

test('fenceDeadEnd fences caller material with the same cap the scheduler applies to captured logs', () => {
  const fenced = fenceDeadEnd('PRIOR_ROUND', 'x'.repeat(DEAD_END_MAX_CHARS * 2));
  assert.equal(DEAD_END_MAX_CHARS, 12_000);
  assert.ok(fenced.length < DEAD_END_MAX_CHARS + 500, `capped (${fenced.length})`);
  assert.match(fenced, /PRIOR_ROUND/);
  assert.equal(typeof fenceDeadEnd('L', undefined), 'string', 'undefined material fences to a string, never throws');
});
