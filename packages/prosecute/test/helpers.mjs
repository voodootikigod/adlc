// Shared fixtures for the per-concern prosecute test files (mirrors packages/gate-fuzzing's
// one-file-per-concern split). Not itself a *.test.mjs file, so `node --test test/*.test.mjs`
// does not try to run it directly.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { sha256 } from '@adlc/core';

import { tmp, gitRepo as coreGitRepo } from '@adlc/core/test-kit';

export const FIXTURE_REVISION = 'fixture-revision';
export const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);

// Every factory below mints a directory per call, and the callers are spread
// across the whole prosecute suite — so cleanup belongs here, once, rather than
// in each caller's finally. The hook is registered when a test file imports this
// module, so it drains that file's fixtures when the file finishes.
const fixtures = new Set();
after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures.clear();
});

function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtures.add(dir);
  return dir;
}

export function tmpAdlc(t) {
  const dir = tmp(t, 'adlc-prosecute-');
  if (!t?.after) fixtures.add(dir);
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Fixture ticket', scope: ['src/**'], rails: ['test/**'], edges: [] },
      { id: 'T10', title: 'Substring guard ticket', scope: ['src/**'], rails: ['test/**'], edges: [] },
    ],
  }));
  return dir;
}

export function gitRepo(t) {
  if (t) {
    return coreGitRepo(t, { prefix: 'adlc-prosecute-git-' });
  }
  const repo = coreGitRepo(null, { prefix: 'adlc-prosecute-git-' });
  fixtures.add(repo.dir);
  return repo;
}

export function transcript(dir, { ticket = 'T1', revision = FIXTURE_REVISION } = {}) {
  const path = join(dir, 'review.txt');
  writeFileSync(path, [
    `ticket: ${ticket}`,
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  return path;
}

export function reviewPacket(dir, { revision = FIXTURE_REVISION, prefix = 'review' } = {}) {
  const prompt = join(dir, `${prefix}-prompt.txt`);
  const inputs = join(dir, `${prefix}-inputs.txt`);
  writeFileSync(prompt, `review prompt for ${revision}\n`);
  writeFileSync(inputs, `reviewed input packet for ${revision}\n`);
  return {
    prompt,
    prompt_hash: sha256(readFileSync(prompt)),
    inputs,
    inputs_hash: sha256(readFileSync(inputs)),
    clean_worktree: revision,
  };
}

export function finding(overrides = {}) {
  return {
    id: 'F1',
    severity: 'high',
    category: 'correctness',
    file: 'src/app.mjs',
    line_start: 1,
    line_end: 1,
    evidence: 'return false',
    claim: 'wrong result',
    recommendation: 'return true',
    confidence: 0.9,
    verified_status: 'verified',
    ...overrides,
  };
}

export function killedFinding(overrides = {}) {
  return finding({
    verified_status: 'killed',
    verification: {
      reason: 'fixture refuted',
      method: 'unit test',
      evidence: 'test passes',
    },
    ...overrides,
  });
}

export function readManifest(dir) {
  return readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
}

export function input(dir, overrides = {}) {
  return {
    provenance: {
      reviewer: 'fixture-reviewer',
      session: 'fixture-session',
      command: 'fixture review command',
      transcript: transcript(dir),
    },
    review_packet: reviewPacket(dir),
    no_findings_attestation: {
      reason: 'fixture reviewer found no candidates',
      method: 'review transcript audit',
      evidence: 'review.txt',
    },
    ...overrides,
  };
}
