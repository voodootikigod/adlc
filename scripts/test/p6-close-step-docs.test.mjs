// T74 — the documented P6 lifecycle must conclude with ticket completion.
// Before this, ADLC.md's P6 section and the adlc skill's P6 block ended at
// "human behavioral acceptance" / "record gate-manifest" and never told the
// operator to actually mark the ticket done, so accepted tickets stayed open
// forever. These grep asserts pin the close step into BOTH docs so it can't
// silently regress.

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

test('adlc skill P6 block documents concluding acceptance with ticket completion', () => {
  const skill = read('plugins/adlc-claude-code/skills/adlc/SKILL.md');
  const p6 = section(skill, '### P6 — Integrate (the human gate)');
  assert.match(p6, /adlc ticket complete/, 'SKILL.md P6 must name the `adlc ticket complete` close step');
  assert.match(p6, /gate-manifest record\s+p6-accept/, 'SKILL.md P6 must name recording the p6-accept verdict');
  assert.match(p6, /--authorize/, 'SKILL.md P6 must note the railed-ticket authorization');
});
