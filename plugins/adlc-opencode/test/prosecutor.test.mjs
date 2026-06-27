// prosecutor.test.mjs — Phase E (T5): the P5 prosecution registry + pure
// orchestration helpers (dedupe, verifier-majority, loop-until-dry). Offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LENSES, VERIFIER, ALL_AGENTS, findingKey, dedupeFindings, survivesVerification, shouldContinue,
} from '../lib/prosecutor.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- registry ----
test('registry: 5 lenses + verifier, ids unique', () => {
  assert.equal(LENSES.length, 5);
  assert.equal(VERIFIER.agent, 'prosecutor-verifier');
  assert.equal(ALL_AGENTS.length, 6);
  assert.equal(new Set(ALL_AGENTS).size, 6);
  for (const k of ['correctness', 'security', 'contract', 'diff', 'tests']) {
    assert.ok(LENSES.some((l) => l.key === k), `${k} lens present`);
  }
});

test('every registry agent has a shipped agent/*.md file with subagent frontmatter', () => {
  const dir = join(PKG, 'agent');
  const files = new Set(readdirSync(dir));
  for (const a of ALL_AGENTS) {
    assert.ok(files.has(`${a}.md`), `${a}.md shipped`);
    const body = readFileSync(join(dir, `${a}.md`), 'utf8');
    assert.match(body, /^---\n[\s\S]*?description:\s*\S+[\s\S]*?mode:\s*subagent[\s\S]*?\n---/, `${a}.md has subagent frontmatter`);
  }
});

// ---- dedupeFindings ----
test('dedupeFindings: collapses same file+line+title, keeps highest severity', () => {
  const findings = [
    { file: 'a.mjs', line_start: 10, line_end: 10, title: 'Null deref', severity: 'low' },
    { file: 'a.mjs', line_start: 10, line_end: 10, title: 'null  deref', severity: 'high' }, // dup (case/space)
    { file: 'b.mjs', line_start: 5, line_end: 5, title: 'Injection', severity: 'critical' },
  ];
  const out = dedupeFindings(findings);
  assert.equal(out.length, 2);
  const a = out.find((f) => f.file === 'a.mjs');
  assert.equal(a.severity, 'high'); // highest kept
});

test('findingKey normalizes title whitespace + case', () => {
  assert.equal(
    findingKey({ file: 'x', line_start: 1, line_end: 2, title: '  Big   Bug ' }),
    findingKey({ file: 'x', line_start: 1, line_end: 2, title: 'big bug' }),
  );
});

// ---- survivesVerification ----
test('survivesVerification: strict majority of real votes survives', () => {
  assert.equal(survivesVerification([{ real: true }, { real: true }, { real: false }]), true); // 2/3
  assert.equal(survivesVerification([{ real: true }, { real: false }]), false); // 1/2 not > 0.5
  assert.equal(survivesVerification([{ real: false }, { real: false }]), false);
});

test('survivesVerification: no votes → does not block (fail open on absent evidence)', () => {
  assert.equal(survivesVerification([]), false);
  assert.equal(survivesVerification(null), false);
});

// ---- shouldContinue (loop until dry) ----
test('shouldContinue: resets dry streak on fresh findings, stops after maxDry empties', () => {
  let s = shouldContinue({ freshThisRound: 3, dryStreak: 1, maxDry: 2 });
  assert.deepEqual(s, { continue: true, dryStreak: 0 });
  s = shouldContinue({ freshThisRound: 0, dryStreak: 0, maxDry: 2 });
  assert.deepEqual(s, { continue: true, dryStreak: 1 });
  s = shouldContinue({ freshThisRound: 0, dryStreak: 1, maxDry: 2 });
  assert.deepEqual(s, { continue: false, dryStreak: 2 });
});
