// T74 — the documented P6 lifecycle must conclude with ticket completion.
// Before this, ADLC.md's P6 section ended at "human behavioral acceptance" and
// never told the operator to actually mark the ticket done, so accepted tickets
// stayed open forever. The close step is pinned into ADLC.md (the full process doc).
//
// It is DELIBERATELY NOT in the generated adlc-skill router (SKILL.md): that file is
// the terse phase -> `adlc <gate>` skeleton, frozen by the consolidation routing guard
// (scripts/router/check-consolidation.mjs). Adding `adlc ticket complete` to its P6
// block registers a new routing token and fails that guard — the completion CEREMONY
// is process detail, not a phase gate. Both directions are asserted so neither
// regresses: ADLC.md must keep the step, the router must NOT grow it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Slice the section that starts at `heading` and ends at the next same-or-higher heading. */
function section(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `heading not found: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length);
  const nextHeading = rest.search(new RegExp(`\\n#{1,${level}} `, 'm'));
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

test('ADLC.md P6 section documents concluding acceptance with ticket completion', () => {
  const p6 = section(read('ADLC.md'), '### P6 — Integrate');
  assert.match(p6, /adlc ticket complete/, 'P6 must name the `adlc ticket complete` close step');
  assert.match(p6, /gate-manifest record p6-accept/, 'P6 must name recording the p6-accept verdict');
  assert.match(p6, /--authorize/, 'P6 must note the railed-ticket authorization/ceremony');
});

test('the adlc-skill router P6 stays the terse gate-manifest routing (ceremony lives in ADLC.md)', () => {
  const skill = read('plugins/adlc-claude-code/skills/adlc/SKILL.md');
  const p6 = section(skill, '### P6 — Integrate (the human gate)');
  // The router's P6 routes to its gate (gate-manifest) and nothing more. The
  // completion ceremony must NOT be here: `adlc ticket complete` would add a routing
  // token and break the consolidation guard. This asserts the routing-freeze holds.
  assert.match(p6, /adlc gate-manifest/, 'the router P6 still names its gate-manifest gate');
  assert.doesNotMatch(p6, /adlc ticket complete/, 'the completion ceremony belongs in ADLC.md, not the frozen router');
});
