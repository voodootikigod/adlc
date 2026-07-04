// prosecutor.test.mjs — Claude Code port of the P5 prosecution registry + pure
// orchestration helpers (issue #61). Ported from
// plugins/adlc-opencode/test/prosecutor.test.mjs so the dedupe/verify/convergence
// contract stays identical across harnesses; only the shipped-agent frontmatter
// shape differs (Claude Code: name/description/tools; OpenCode:
// description/mode/permission). Offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LENSES, VERIFIER, ALL_AGENTS, findingKey, dedupeFindings, survivesVerification, shouldContinue,
} from '../prosecutor.mjs';

// This test file lives at plugins/adlc-claude-code/lib/test/, two levels below
// the plugin root (unlike OpenCode's test/ which is one level below its package
// root) — dirname three times to reach plugins/adlc-claude-code/.
const PKG = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

test('every registry agent has a shipped agents/*.md file with Claude Code subagent frontmatter', () => {
  const dir = join(PKG, 'agents');
  const files = new Set(readdirSync(dir));
  for (const a of ALL_AGENTS) {
    assert.ok(files.has(`${a}.md`), `${a}.md shipped`);
    const body = readFileSync(join(dir, `${a}.md`), 'utf8');
    // Claude Code subagent frontmatter: name / description / tools (no mode/permission
    // block — that is OpenCode's convention). name must match the registry agent id.
    assert.match(body, /^---\n[\s\S]*?name:\s*\S+[\s\S]*?description:\s*\S+[\s\S]*?tools:\s*\S+[\s\S]*?\n---/, `${a}.md has name/description/tools frontmatter`);
    assert.match(body, new RegExp(`^---\\nname:\\s*${a}\\s*\\n`), `${a}.md frontmatter name matches registry agent id`);
    // These lenses are hostile read-only reviewers: no Edit/Write/MultiEdit/Bash tool
    // grant. A lens or the verifier that can edit or shell out could tamper with the
    // evidence it is supposed to adversarially assess.
    const frontmatterEnd = body.indexOf('\n---', 4);
    const frontmatter = body.slice(0, frontmatterEnd);
    assert.doesNotMatch(frontmatter, /tools:.*\b(Edit|Write|MultiEdit|Bash)\b/, `${a}.md must not grant Edit/Write/MultiEdit/Bash`);
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

test('findingKey treats different line ranges as distinct findings', () => {
  assert.notEqual(
    findingKey({ file: 'x', line_start: 1, line_end: 2, title: 'Bug' }),
    findingKey({ file: 'x', line_start: 3, line_end: 4, title: 'Bug' }),
  );
});

// ---- survivesVerification ----
test('survivesVerification: strict majority of real votes survives', () => {
  assert.equal(survivesVerification([{ real: true }, { real: true }, { real: false }]), true); // 2/3
  assert.equal(survivesVerification([{ real: true }, { real: false }]), false); // 1/2 not > 0.5
  assert.equal(survivesVerification([{ real: false }, { real: false }]), false);
});

test('survivesVerification: no valid votes → SURVIVES as unverified blocker (fail closed)', () => {
  // A verifier crash/timeout must NOT silently drop a finding in a pre-merge gate.
  assert.equal(survivesVerification([]), true);
  assert.equal(survivesVerification(null), true);
  assert.equal(survivesVerification([null, undefined]), true); // no valid votes
});

test('survivesVerification: mixed valid/invalid votes only count the valid ones', () => {
  // 1 real out of 1 valid vote (the null is discarded, not counted as a "no" vote).
  assert.equal(survivesVerification([{ real: true }, null]), true);
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

test('shouldContinue: two consecutive dry rounds from a cold start stop the loop', () => {
  let s = shouldContinue({ freshThisRound: 0, dryStreak: 0 });
  assert.deepEqual(s, { continue: true, dryStreak: 1 });
  s = shouldContinue({ freshThisRound: 0, dryStreak: s.dryStreak });
  assert.deepEqual(s, { continue: false, dryStreak: 2 });
});
