// prosecute-agents.test.mjs — T66 AC9/AC10: agents roster + recorder packet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInput } from '../../../packages/prosecute/lib/schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, '..', 'agents');
const REQUIRED = [
  'prosecutor-correctness.md',
  'prosecutor-security.md',
  'prosecutor-contract.md',
  'prosecutor-diff.md',
  'prosecutor-tests.md',
  'prosecutor-verifier.md',
];

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, 'frontmatter required');
  const fm = m[1];
  const get = (k) => {
    const line = fm.split('\n').find((l) => l.startsWith(`${k}:`));
    return line ? line.slice(k.length + 1).trim() : null;
  };
  return { raw: fm, get };
}

test('AC9: required prosecutor agents exist with readonly:true and no tools:', () => {
  for (const file of REQUIRED) {
    const path = join(AGENTS, file);
    assert.ok(existsSync(path), `${file} must exist`);
    const fm = frontmatter(readFileSync(path, 'utf8'));
    assert.ok(fm.get('name'), `${file} needs name`);
    assert.ok(fm.get('description'), `${file} needs description`);
    assert.equal(fm.get('readonly'), 'true', `${file} must set readonly: true`);
    assert.doesNotMatch(fm.raw, /^tools:/m, `${file} must not use Claude tools: frontmatter`);
  }
});

test('AC9: packaging allowlist + plugin.json register agents/', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files?.includes('agents/'));
  assert.equal(pkg.cursor?.agents, './agents/');
  const manifest = JSON.parse(readFileSync(join(HERE, '..', '.cursor-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.agents, './agents/');
  assert.ok(readdirSync(AGENTS).length >= REQUIRED.length);
});

test('AC10: five-pass packet with contract+diff validates through real recorder', () => {
  const input = {
    provenance: {
      reviewer: 'fixture',
      session: 's1',
      command: '/adlc-prosecute',
      transcript: 'fixture transcript',
    },
    review_packet: {
      prompt: 'prosecute',
      prompt_hash: 'p'.repeat(64),
      inputs: 'diff',
      inputs_hash: 'i'.repeat(64),
      clean_worktree: 'clean',
    },
    no_findings_attestation: {
      reason: 'fixture dry five-pass',
      method: 'unit',
      evidence: 'empty findings by construction',
    },
    passes: [
      { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      { lens: 'security', findings: [], dry_evidence: 'no security findings' },
      { lens: 'contract', findings: [], dry_evidence: 'no contract findings' },
      { lens: 'diff', findings: [], dry_evidence: 'no diff findings' },
      { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
    ],
  };
  const errors = validateInput(input);
  assert.deepEqual(errors, []);
  // Missing a required core lens key must fail when that key is used incorrectly
  const bad = validateInput({
    ...input,
    passes: [{ lens: 'not-a-lens', findings: [], dry_evidence: 'x' }],
  });
  assert.ok(bad.some((e) => /lens must be one of/.test(e)));
});
