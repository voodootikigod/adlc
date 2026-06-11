// test/run-review.test.mjs — Tests for run-review.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isFindingLine,
  parseFindingLine,
  runReviewCmd,
  parseFindingsFromOutput,
  tokenizeCommand,
  substituteToken,
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

  it('passes a filename with spaces as ONE literal arg', () => {
    // With shell:false tokenization, the substituted value is a single argv
    // element even though it contains a space.
    const result = runReviewCmd(
      `node -e "process.stdout.write(process.argv[1])" {file}`,
      'src/has space.mjs',
    );
    assert.equal(result.stdout, 'src/has space.mjs');
    assert.equal(result.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// tokenizeCommand / substituteToken
// ---------------------------------------------------------------------------

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(tokenizeCommand('node script.mjs {file}'), ['node', 'script.mjs', '{file}']);
  });

  it('keeps quoted segments as one token', () => {
    assert.deepEqual(tokenizeCommand('node -e "a b c" {file}'), ['node', '-e', 'a b c', '{file}']);
  });

  it('throws on an unterminated quote', () => {
    assert.throws(() => tokenizeCommand('node -e "oops'), /Unterminated quote/);
  });
});

describe('substituteToken', () => {
  it('substitutes a bare placeholder token as a literal', () => {
    assert.deepEqual(substituteToken(['cmd', '{file}'], '{file}', '$(touch X)'), ['cmd', '$(touch X)']);
  });

  it('substitutes inside a flag token without splitting', () => {
    assert.deepEqual(
      substituteToken(['cmd', '--file={file}'], '{file}', 'a b.mjs'),
      ['cmd', '--file=a b.mjs'],
    );
  });
});

// ---------------------------------------------------------------------------
// SECURITY: command injection via malicious filename (regression)
// ---------------------------------------------------------------------------

describe('runReviewCmd — command injection regression', () => {
  it('does NOT execute a shell payload embedded in the filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-injection-'));
    try {
      const sentinel = join(dir, 'PWNED');
      // A filesystem-derived filename an attacker could commit. If the value is
      // ever handed to /bin/sh, $(touch PWNED) executes and creates the file.
      const maliciousFile = `$(touch ${sentinel}).mjs`;

      // Deterministic, offline review cmd: echo the arg back. The payload must
      // arrive as a LITERAL string, and PWNED must NOT exist afterwards.
      const result = runReviewCmd(
        `node -e "process.stdout.write(process.argv[1])" {file}`,
        maliciousFile,
      );

      assert.equal(
        existsSync(sentinel), false,
        'INJECTION: shell executed $(touch PWNED) from the filename',
      );
      // The untrusted value arrived verbatim as a single literal argument.
      assert.equal(result.stdout, maliciousFile);
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT execute a "; touch" payload embedded in the filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-injection-'));
    try {
      const sentinel = join(dir, 'PWNED');
      const maliciousFile = `x.mjs; touch ${sentinel}`;
      const result = runReviewCmd(
        `node -e "process.stdout.write(process.argv[1])" {file}`,
        maliciousFile,
      );
      assert.equal(existsSync(sentinel), false, 'INJECTION: "; touch" executed');
      assert.equal(result.stdout, maliciousFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
