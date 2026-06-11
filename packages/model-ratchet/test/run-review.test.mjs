// test/run-review.test.mjs — Tests for run-review.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isFindingLine,
  parseFindingLine,
  runReviewCmd,
  parseFindingsFromOutput,
} from '../lib/run-review.mjs';

// ---------------------------------------------------------------------------
// isFindingLine
// ---------------------------------------------------------------------------

describe('isFindingLine', () => {
  it('matches file:lineNo pattern', () => {
    assert.equal(isFindingLine('src/foo.js:42: null pointer'), true);
    assert.equal(isFindingLine('  lib/bar.ts:10: unused var  '), true);
  });

  it('matches bullet lines starting with "- "', () => {
    assert.equal(isFindingLine('- missing error handling'), true);
    assert.equal(isFindingLine('  - indented bullet'), true);
  });

  it('rejects empty lines', () => {
    assert.equal(isFindingLine(''), false);
    assert.equal(isFindingLine('   '), false);
  });

  it('rejects plain info lines', () => {
    assert.equal(isFindingLine('Running analysis...'), false);
    assert.equal(isFindingLine('Done.'), false);
  });
});

// ---------------------------------------------------------------------------
// parseFindingLine
// ---------------------------------------------------------------------------

describe('parseFindingLine', () => {
  it('parses file:lineNo at start', () => {
    const r = parseFindingLine('src/foo.js:42: null pointer', 'src/foo.js');
    assert.equal(r.parsedLine, 42);
    assert.ok(r.desc.includes('null pointer'));
  });

  it('parses bullet line (no location)', () => {
    const r = parseFindingLine('- missing error handling', 'src/x.mjs');
    assert.equal(r.parsedLine, null);
    assert.ok(r.desc.includes('missing error handling'));
  });

  it('parses inline file:lineNo reference', () => {
    const r = parseFindingLine('Issue found at lib/y.ts:7 in loop', 'src/a.mjs');
    assert.ok(r.location !== null);
  });
});

// ---------------------------------------------------------------------------
// parseFindingsFromOutput
// ---------------------------------------------------------------------------

describe('parseFindingsFromOutput', () => {
  it('extracts finding lines from mixed output', () => {
    const stdout = [
      'Analyzing file...',
      'src/auth.js:12: missing null check',
      '- logic error in branch',
      'Summary: 2 issues',
      '',
    ].join('\n');

    const findings = parseFindingsFromOutput(stdout, 'src/auth.js');
    assert.equal(findings.length, 2);
    assert.equal(findings[0].tool, 'model-ratchet');
    assert.equal(findings[0].file, 'src/auth.js');
    assert.equal(findings[0].category, 'ratchet');
    assert.equal(findings[0].severity, 'unknown');
    assert.ok(typeof findings[0].ts === 'string');
  });

  it('returns empty array for no findings', () => {
    const stdout = 'All good.\nDone.\n';
    const findings = parseFindingsFromOutput(stdout, 'src/clean.mjs');
    assert.equal(findings.length, 0);
  });

  it('sets line to null for bullet findings', () => {
    const stdout = '- potential issue\n';
    const findings = parseFindingsFromOutput(stdout, 'src/x.mjs');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, null);
  });

  it('sets line number for file:line findings', () => {
    const stdout = 'src/x.mjs:99: bad code\n';
    const findings = parseFindingsFromOutput(stdout, 'src/x.mjs');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 99);
  });
});

// ---------------------------------------------------------------------------
// runReviewCmd — {file} substitution
// ---------------------------------------------------------------------------

describe('runReviewCmd', () => {
  it('substitutes {file} in command', () => {
    // Use a node command that echoes back the arg
    const result = runReviewCmd(`node -e "process.stdout.write('{file}')"`, 'src/foo.mjs');
    assert.equal(result.stdout.trim(), 'src/foo.mjs');
    assert.equal(result.exitCode, 0);
  });

  it('captures stdout correctly', () => {
    const result = runReviewCmd(`node -e "console.log('- finding one')"`, 'any.mjs');
    assert.ok(result.stdout.includes('- finding one'));
  });

  it('reports non-zero exit code', () => {
    const result = runReviewCmd(`node -e "process.exit(1)"`, 'x.mjs');
    assert.equal(result.exitCode, 1);
  });
});
