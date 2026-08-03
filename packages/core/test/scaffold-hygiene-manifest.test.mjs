// scaffold-hygiene-manifest.test.mjs — @adlc/core's GITIGNORE_STANZA is the
// one the cursor, opencode, and pi scaffolders use (they all call this
// package's ensureGitignore). It must establish the same two-sided contract
// as @adlc/init's defaults, or a repo scaffolded through those harnesses
// keeps its C11 evidence ledger local-only and `gate-manifest enable`
// refuses it outright.
//
// Behavioral, through real `git check-ignore` — a contents assertion cannot
// tell a correct rule set from one whose ORDER makes the negations dead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGitignore } from '../lib/scaffold-hygiene.mjs';

function gitFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-core-gitignore-manifest-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ignored(root, relPath) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', relPath], { cwd: root });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git check-ignore failed for ${relPath} (status ${r.status}): ${r.stderr}`);
  }
  return r.status === 0;
}

const COMMITTABLE = [
  '.adlc/manifest.jsonl',
  '.adlc/manifest.d/',
  '.adlc/manifest.d/.store.json',
  '.adlc/manifest.d/main-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl',
];
const MUST_STAY_IGNORED = [
  '.adlc/manifest.d/.lineage',
  '.adlc/manifest.d/manifest.lock',
  '.adlc/manifest.d/.store.json.tmp-a1b2c3d4e5f6',
];

function assertContract(root, label) {
  mkdirSync(join(root, '.adlc/manifest.d'), { recursive: true });
  for (const p of COMMITTABLE) {
    assert.equal(ignored(root, p), false, `${label}: ${p} MUST be committable`);
  }
  for (const p of MUST_STAY_IGNORED) {
    assert.equal(ignored(root, p), true, `${label}: ${p} MUST stay ignored`);
  }
}

test('a fresh repo scaffolded through core can commit its manifest evidence', () => {
  gitFixture((root) => {
    ensureGitignore(root);
    assertContract(root, 'fresh');
  });
});

test('a repo holding the OLD core stanza gains the manifest lines in effective order', () => {
  gitFixture((root) => {
    writeFileSync(join(root, '.gitignore'), [
      'node_modules/',
      '.adlc/*',
      '!.adlc/tickets.json',
      '!.adlc/tickets/',
      '!.adlc/tickets/**',
      '!.adlc/ticket-archive/',
      '!.adlc/ticket-archive/**',
      '!.adlc/specs/',
      '',
    ].join('\n'));
    const result = ensureGitignore(root);
    assert.equal(result.changed, true);
    assertContract(root, 'old-stanza upgrade');
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    assert.equal(lines.filter((l) => l === '.adlc/*').length, 1, 'no duplicate anchor');
    assert.ok(lines.includes('node_modules/'), 'unrelated rules survive');
  });
});

test('core scaffolding is idempotent once the full stanza is present', () => {
  gitFixture((root) => {
    ensureGitignore(root);
    const first = readFileSync(join(root, '.gitignore'), 'utf8');
    const second = ensureGitignore(root);
    assert.equal(second.changed, false, 'a fully-present stanza rewrites nothing');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), first);
  });
});

test('a stray re-ignore placed before the anchor is relocated so the negations still win', () => {
  gitFixture((root) => {
    writeFileSync(join(root, '.gitignore'), [
      '.adlc/manifest.d/.lineage',
      '.adlc/*',
      '!.adlc/tickets.json',
      '',
    ].join('\n'));
    ensureGitignore(root);
    assertContract(root, 'stray re-ignore before anchor');
  });
});

// NOTE: fixtures for ordering repair, anchor-spelling normalization, CRLF and
// symlink handling live with those fixes, tracked as defects B-F on
// T-01KZ3QJMCCVSQPWR1QZC9Y9BP9. This slice establishes the CONTRACT only —
// that core emits the same manifest entries @adlc/init does, so repos
// scaffolded through the cursor/opencode/pi harnesses can commit evidence.
