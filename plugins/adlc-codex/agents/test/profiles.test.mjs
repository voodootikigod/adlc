// profiles.test.mjs — T54 AC1: the six P5 prosecution agent profiles exist,
// are read-only, and each names its lens's specific hunted failure classes.
// No TOML parser dependency (this repo is zero-dependency by convention) —
// these are lightweight text assertions, matching how
// scripts/codex-install-smoke.mjs already checks agent profiles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const PROFILES = [
  { file: 'adlc-prosecutor-correctness.toml', name: 'adlc-prosecutor-correctness', mustContain: ['logic errors', 'broken invariants'] },
  { file: 'adlc-prosecutor-security.toml', name: 'adlc-prosecutor-security', mustContain: ['injection', 'trust-boundary'] },
  { file: 'adlc-prosecutor-contract.toml', name: 'adlc-prosecutor-contract', mustContain: ['API/schema/type', 'backwards-incompatible'] },
  { file: 'adlc-prosecutor-diff.toml', name: 'adlc-prosecutor-diff', mustContain: ['implementation diff', 'scope creep'] },
  { file: 'adlc-prosecutor-tests.toml', name: 'adlc-prosecutor-tests', mustContain: ['hollow', 'mock-only'] },
  { file: 'adlc-prosecutor-verifier.toml', name: 'adlc-prosecutor-verifier', mustContain: ['REFUTED', 'real'] },
];

for (const profile of PROFILES) {
  test(`${profile.file} is a read-only agent profile naming its lens`, () => {
    const path = join(AGENTS_DIR, profile.file);
    const text = readFileSync(path, 'utf8');
    assert.match(text, new RegExp(`name = "${profile.name}"`), 'declares its own name');
    assert.match(text, /sandbox_mode = "read-only"/, 'is read-only');
    assert.match(text, /developer_instructions = """/, 'has instructions block');
    assert.match(text, /description = ".+"/, 'has a non-empty description');
    for (const needle of profile.mustContain) {
      assert.ok(
        text.includes(needle) || text.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' ')),
        `${profile.file} should mention "${needle}"`,
      );
    }
  });
}

test('all six prosecution agents are distinct files', () => {
  const names = new Set(PROFILES.map((p) => p.name));
  assert.equal(names.size, PROFILES.length);
});

test('adlc-prosecute SKILL.md documents the fan-out and names every agent', () => {
  const skillPath = join(AGENTS_DIR, '..', 'skills', 'adlc-prosecute', 'SKILL.md');
  const text = readFileSync(skillPath, 'utf8');
  assert.ok(!/does not run the reviewer by itself\./.test(text), 'no longer disclaims running the reviewer without qualification');
  for (const required of ['Fan out five independent lenses', 'Dedupe', 'Verify independently', 'Loop until dry']) {
    assert.ok(text.includes(required), `SKILL.md should document the "${required}" step`);
  }
  for (const profile of PROFILES) {
    assert.ok(text.includes(profile.name), `SKILL.md should name ${profile.name}`);
  }
});
