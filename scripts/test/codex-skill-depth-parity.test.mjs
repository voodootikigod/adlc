// codex-skill-depth-parity.test.mjs — T51. Content-presence checks for the
// satellite-skill depth added to adlc-spec (P0 ticket authoring) and
// adlc-distill (P7 maintenance). Does NOT touch plugins/adlc-codex/skills/
// adlc/SKILL.md — that file is GENERATED (scripts/router/gen-routers.mjs).
//
// Lives in scripts/test/, not plugins/adlc-codex/skills/test/ — a sibling
// directory there is enumerated by codex-skill-metadata.test.mjs as if it
// were a 7th skill, which a `skills/test/` location broke on first attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'adlc-codex', 'skills');
const read = (rel) => readFileSync(join(SKILLS_DIR, rel), 'utf8');

test('adlc-spec/SKILL.md covers the P0 ticket-authoring protocol steps', () => {
  const text = read('adlc-spec/SKILL.md');
  for (const required of [
    'Preconditions', 'Shape the ticket', 'atomic', 'coldstart',
    'formatter', 'edges', 'scope-widening', 'rail-narrowing',
  ]) {
    assert.ok(text.includes(required), `adlc-spec/SKILL.md should cover "${required}"`);
  }
});

test('adlc-distill/SKILL.md covers all four P7 maintenance checks with exit-code semantics', () => {
  const text = read('adlc-distill/SKILL.md');
  for (const required of ['skill-rot', 'model-ratchet', 'ticket-prune', 'gate-fuzzing']) {
    assert.ok(text.includes(required), `adlc-distill/SKILL.md should cover "${required}"`);
  }
  for (const exitCode of ['Exit `0`', 'Exit `2`', 'Exit `1`']) {
    assert.ok(text.includes(exitCode), `adlc-distill/SKILL.md should document ${exitCode}`);
  }
  assert.match(text, /Scheduling|cron/, 'should document the cron-vs-session split');
});

test('no skill under plugins/adlc-codex/skills references a Claude-Code-only /adlc: invocation form', () => {
  let matches = '';
  try {
    matches = execSync(`grep -rln --include='SKILL.md' '${'/adlc:'}' "${SKILLS_DIR}"`, { encoding: 'utf8' });
  } catch (err) {
    // grep exits 1 when there are no matches — that's the success case here.
    if (err.status !== 1) throw err;
  }
  assert.equal(matches.trim(), '', `found /adlc: references in:\n${matches}`);
});

test('the router (adlc/SKILL.md) is untouched by this ticket — still the minimal, no-phase-map form', () => {
  const text = read('adlc/SKILL.md');
  assert.ok(!/### P0 —|### P1 —|### P7 —/.test(text), 'router must not carry the full-map phase headings (that is claude-code/antigravity\'s format, not codex\'s)');
});

test('every skill directory still has its SKILL.md (no accidental removal)', () => {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'test');
  for (const d of dirs) {
    assert.doesNotThrow(() => read(`${d.name}/SKILL.md`), `${d.name}/SKILL.md should still exist`);
  }
});
