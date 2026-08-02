// gitignore-manifest.test.mjs — the scaffolded ignore rules must let the C11
// evidence ledger COMMIT (T-01KYZ1MH94BVC5D8VMEASQJQ7V).
//
// These assert behavior through real `git check-ignore`, not the contents of
// the constant: a pinned-array test cannot tell a correct rule set from one
// whose ORDER makes the negations dead (gitignore is last-match-wins), and
// order is the whole difficulty here.
//
// The contract is two-sided, matching `gate-manifest enable`'s own check:
//   COMMITTABLE — manifest.jsonl, manifest.d/, the activation marker, segments
//   IGNORED     — manifest.d/.lineage (checkout-local), manifest.d/*.lock

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../index.mjs';

function gitFixture(fn) {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-init-gitignore-'));
  const root = join(parent, 'repo');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    return fn(root);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

// A path is "ignored" when check-ignore exits 0. Directories are probed with a
// trailing slash and created first — a bare probe on a not-yet-existing
// directory misreports, which has bitten this repo before.
function ignored(root, relPath) {
  return spawnSync('git', ['check-ignore', '-q', '--', relPath], { cwd: root }).status === 0;
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
];

function assertContract(root, label) {
  mkdirSync(join(root, '.adlc/manifest.d'), { recursive: true });
  for (const p of COMMITTABLE) {
    assert.equal(ignored(root, p), false, `${label}: ${p} MUST be committable — evidence that never reaches the remote is invisible to CI, clones, and reviewers`);
  }
  for (const p of MUST_STAY_IGNORED) {
    assert.equal(ignored(root, p), true, `${label}: ${p} MUST stay ignored — a committed lineage token recreates the merge conflict forest mode removes`);
  }
}

test('AC1 — a freshly scaffolded repo can commit its manifest evidence, and still ignores the checkout-local token', () => {
  gitFixture((root) => {
    scaffold({ root });
    assertContract(root, 'fresh scaffold');
  });
});

test('AC2 — re-running init on a repo holding the OLD default block adds the missing lines exactly once', () => {
  gitFixture((root) => {
    // The pre-fix block, verbatim: everything under .adlc ignored, no manifest negations.
    writeFileSync(join(root, '.gitignore'), [
      'node_modules/',
      '',
      '# ADLC runtime',
      '.adlc/*',
      '!.adlc/config.json',
      '!.adlc/tickets.json',
      '!.adlc/tickets/',
      '!.adlc/tickets/**',
      '!.adlc/ticket-archive/',
      '!.adlc/ticket-archive/**',
      '!.adlc/specs/',
      '',
    ].join('\n'));

    scaffold({ root });
    assertContract(root, 're-run upgrade');

    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    for (const line of ['.adlc/*', '!.adlc/config.json', '!.adlc/manifest.jsonl', '!.adlc/manifest.d/', '.adlc/manifest.d/.lineage']) {
      assert.equal(lines.filter((l) => l === line).length, 1, `${line} must appear exactly once — no duplication on re-run`);
    }
    assert.ok(lines.includes('node_modules/'), 'pre-existing unrelated rules survive');
  });
});

test('scaffolding twice is idempotent — the second run leaves the file byte-identical', () => {
  gitFixture((root) => {
    scaffold({ root });
    const first = readFileSync(join(root, '.gitignore'), 'utf8');
    scaffold({ root });
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), first);
    assertContract(root, 'second run');
  });
});

test('a repo that ignored ALL of .adlc is normalized so the negations can take effect', () => {
  gitFixture((root) => {
    // `.adlc/` excludes the directory itself, and git cannot re-include
    // anything inside an excluded directory — scaffold rewrites it to
    // `.adlc/*` precisely so the negations below it are not dead.
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.adlc/\n');
    scaffold({ root });
    assertContract(root, 'whole-.adlc normalization');
  });
});
