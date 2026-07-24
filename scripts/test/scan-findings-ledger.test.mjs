// The independent git-boundary scan of the committed findings ledger. It must catch a
// secret that NEVER went through the append API (a manual edit, a merge, a git add) —
// the exact bypass the write-time filter cannot see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan as scanInProcess } from '../scan-findings-ledger.mjs';

const SCANNER = new URL('../scan-findings-ledger.mjs', import.meta.url).pathname;

// The subprocess exit code cannot distinguish `return 0` from `return null` (both exit 0),
// so pin the exact clean-case return value in-process — a strict 0, not any falsy value.
test('scan() returns EXACTLY 0 (not null/undefined) for an absent ledger', () => {
  assert.strictEqual(scanInProcess('/nonexistent/path/findings.jsonl'), 0);
});

function scan(ledgerPath) {
  try {
    const stdout = execFileSync('node', [SCANNER, ledgerPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function withLedger(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-ledger-'));
  const p = join(dir, 'findings.jsonl');
  try {
    writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    return fn(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('passes a clean, curated ledger', () => {
  withLedger([
    { tool: 'prosecutor', file: 'a.mjs', desc: 'survivesVerification failed open on a malformed vote' },
    { tool: 'prosecutor', file: 'b.mjs', desc: 'the buildgate allowlist was narrower than the rails path it shadows' },
  ], (p) => assert.equal(scan(p).code, 0));
});

test('catches a hand-edited secret line that bypassed the append API', () => {
  const r = withLedger([
    { tool: 'prosecutor', file: 'a.mjs', desc: 'a normal finding' },
    { tool: 'manual-edit', file: 'b.mjs', desc: 'token github_pat_11ABCDEFG0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb committed' },
  ], (p) => scan(p));
  assert.equal(r.code, 2, 'a suspected secret fails the scan');
  assert.match(r.out, /line 2/);
  assert.match(r.out, /GitHub fine-grained token/);
});

test('catches a secret smuggled into a NON-parseable line (raw-text fallback)', () => {
  const r = withLedger([
    'not valid json but contains AKIA1234567890ABCDEF anyway',
  ], (p) => scan(p));
  assert.equal(r.code, 2, 'a malformed line is scanned as raw text, not skipped');
});

test('FAILS on a malformed line even with no secret — readEntries would silently skip it', () => {
  // A corrupt committed ledger passes nothing downstream: readEntries drops the line
  // and lesson-foundry never sees that finding. The gate must catch the corruption
  // itself, not only a secret hiding in it.
  const r = withLedger([
    { tool: 'prosecutor', file: 'a.mjs', desc: 'a normal finding' },
    'this line is not valid json and harmless',
  ], (p) => scan(p));
  assert.equal(r.code, 2, 'a malformed record fails the scan on its own');
  assert.match(r.out, /malformed JSONL record/);
});

test('tolerates a missing ledger (exit 0, nothing to scan)', () => {
  assert.equal(scan('/nonexistent/path/findings.jsonl').code, 0);
});
