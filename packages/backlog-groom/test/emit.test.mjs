// emit.test.mjs — AC12.
//
// The emitted set is the ONLY external contract this half has, and it has no
// live consumer yet: `issue-lanes` adoption is a separate ticket. So the shape
// is pinned against a committed fixture and carries a schema version. A shape
// change without a version bump must fail HERE, loudly, rather than drift
// silently until someone tries to consume it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EMIT_KEYS, EMIT_SCHEMA_VERSION, ISSUE_KEYS, emitGroomedSet } from '../lib/emit.mjs';
import { groom } from '../lib/groom.mjs';
import { parseProfile } from '../lib/profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'groomed-set.v4.json'), 'utf8'));

const PROFILE = parseProfile({
  schemaVersion: 1,
  units: [{ name: 'parallax', paths: ['packages/parallax/**'] }],
  frozenPaths: ['packages/rails-guard/**'],
});

const FILES = {
  'packages/parallax/lib/modes.mjs': "const agreements = divergenceResult.agreements ?? [];\n",
  'packages/parallax/lib/scoring.mjs': 'nothing like the citation\n',
};

function fixedWorld() {
  return {
    fetchIssues: () => ({
      truncated: null,
      unconsultable: null,
      issues: [
        {
          number: 705,
          title: 'parallax: off-schema divergence payload scores 0.00',
          body: '**Location** `packages/parallax/lib/modes.mjs:86`\n\n```\nconst agreements = divergenceResult.agreements ?? [];\n```\n',
          labels: ['bug', 'P3-low', 'area:review'],
          url: 'https://example.invalid/705',
          updatedAt: '2026-09-01T00:00:00Z',
        },
        {
          number: 706,
          title: 'parallax: failed readings shrink the fan',
          body: '**Location** `packages/parallax/lib/scoring.mjs:14`\n\n```\nif (total === 0) return 0;\n```\n',
          labels: ['bug', 'P1-high', 'area:review'],
          url: 'https://example.invalid/706',
          updatedAt: '2026-09-02T00:00:00Z',
        },
        {
          number: 700,
          title: 'plan the quarter',
          body: 'We should discuss the roadmap and decide what matters.',
          labels: ['documentation'],
          url: 'https://example.invalid/700',
          updatedAt: '2026-09-03T00:00:00Z',
        },
      ],
    }),
    readFile: (p) => {
      if (!(p in FILES)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return FILES[p];
    },
    pathExists: (p) => p in FILES,
    lastCommitFor: () => 'cafe123',
  };
}

test('AC12: the emitted set matches the committed fixture field-for-field', () => {
  const { set } = groom({ profile: PROFILE, io: fixedWorld(), generatedFor: 'fixture' });
  assert.deepEqual(set, FIXTURE, 'a shape or value change must be a deliberate fixture update, never a silent drift');
});

test('AC12: the set carries a schema version, and the fixture pins the same one', () => {
  const { set } = groom({ profile: PROFILE, io: fixedWorld(), generatedFor: 'fixture' });
  assert.equal(set.schemaVersion, EMIT_SCHEMA_VERSION);
  assert.equal(FIXTURE.schemaVersion, EMIT_SCHEMA_VERSION, 'bumping the version without regenerating the fixture must fail');
});

test('AC12: a shape change without a version bump fails — the key set is pinned', () => {
  const { set } = groom({ profile: PROFILE, io: fixedWorld(), generatedFor: 'fixture' });
  assert.deepEqual(Object.keys(set), [...EMIT_KEYS], 'key set AND order are the contract');
  assert.deepEqual(Object.keys(FIXTURE), [...EMIT_KEYS]);
  for (const row of set.issues) {
    assert.deepEqual(Object.keys(row), [...ISSUE_KEYS]);
  }
});

test('AC12: every declared key is always present, even when empty', () => {
  // A consumer must not have to distinguish "no relations" from "relations not
  // computed" by guessing at an absent key.
  const set = emitGroomedSet({ coverage: { total: 0, routes: {}, verdicts: {}, mechanicalShare: 0, truncated: null } });
  for (const k of EMIT_KEYS) assert.ok(Object.hasOwn(set, k), `missing ${k}`);
  assert.deepEqual(set.issues, []);
  assert.deepEqual(set.relations, []);
});

test('AC12: an unconsultable fetch yields no set at all — never an empty one', () => {
  const io = fixedWorld();
  io.fetchIssues = () => ({ issues: [], unconsultable: 'gh failed', truncated: null });
  const r = groom({ profile: PROFILE, io });
  assert.equal(r.ok, false);
  assert.equal(r.set, null, 'an empty set would claim a clean backlog that was never read');
  assert.match(r.unconsultable, /gh failed/);
});

test('AC12: truncation is carried into the emitted set, not just the report', () => {
  const io = fixedWorld();
  const inner = io.fetchIssues;
  io.fetchIssues = () => ({ ...inner(), truncated: 500 });
  const { set } = groom({ profile: PROFILE, io });
  assert.equal(set.truncated, 500);
  assert.equal(set.coverage.truncated, 500);
});
