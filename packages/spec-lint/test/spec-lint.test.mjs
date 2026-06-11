// spec-lint tests — offline, pure-function focused, no API keys.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { parseCriteria } from '../lib/parse.mjs';
import { classifyCriterion, classifyAll, applyLlmDemotion } from '../lib/classify.mjs';
import { buildJsonResult, buildHumanReport } from '../lib/report.mjs';
import { buildVacuousPrompt } from '../lib/llm.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

function fixture(name) {
  return join(FIXTURES, name);
}

function runCli(args, opts = {}) {
  const bin = new URL('../bin/spec-lint.mjs', import.meta.url).pathname;
  try {
    const out = execFileSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      ...opts,
    });
    return { stdout: out, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// parseCriteria — list items under recognized headings
// ---------------------------------------------------------------------------

describe('parseCriteria', () => {
  it('extracts list items under "Acceptance Criteria" heading', () => {
    const md = `# Spec\n## Acceptance Criteria\n- Item one\n- Item two\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 2);
    assert.equal(criteria[0].text, 'Item one');
    assert.equal(criteria[1].text, 'Item two');
  });

  it('recognises heading variants: Requirements', () => {
    const md = `## Requirements\n- Req one\n* Req two\n1. Req three\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 3);
  });

  it('recognises heading: Definition of Done', () => {
    const md = `## Definition of Done\n- Done one\n- Done two\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 2);
  });

  it('recognises heading: Success', () => {
    const md = `## Success\n- Pass this\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 1);
    assert.equal(criteria[0].text, 'Pass this');
  });

  it('recognises heading: Criteria (substring match)', () => {
    const md = `## Criteria\n- criterion\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 1);
  });

  it('does not collect items under non-criteria headings', () => {
    const md = `## Background\n- ignored\n## Acceptance Criteria\n- included\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 1);
    assert.equal(criteria[0].text, 'included');
  });

  it('handles checkbox list items (- [ ] and - [x])', () => {
    const md = `## Acceptance Criteria\n- [ ] unchecked\n- [x] checked\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 2);
    assert.equal(criteria[0].text, 'unchecked');
    assert.equal(criteria[1].text, 'checked');
  });

  it('returns empty array when no criteria section exists', () => {
    const md = `# Random doc\n\nSome text.\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 0);
  });

  it('captures standalone MUST lines regardless of section', () => {
    const md = `## Background\nMUST validate tokens: \`jwt verify\`\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 1);
    assert.equal(criteria[0].source, 'must-should');
  });

  it('captures standalone SHOULD lines', () => {
    const md = `SHOULD log errors: verified by logs.spec.ts\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria.length, 1);
    assert.match(criteria[0].text, /SHOULD/);
  });

  it('records correct 1-based line numbers', () => {
    const md = `## Acceptance Criteria\n\n- First item\n- Second item\n`;
    const criteria = parseCriteria(md);
    assert.equal(criteria[0].line, 3);
    assert.equal(criteria[1].line, 4);
  });
});

// ---------------------------------------------------------------------------
// classifyCriterion — verification markers
// ---------------------------------------------------------------------------

describe('classifyCriterion', () => {
  it('VERIFIED: backtick command', () => {
    const r = classifyCriterion('Run `npm test` to verify');
    assert.ok(r.verified);
    assert.match(r.reason, /backtick/);
  });

  it('VERIFIED: .test. file path', () => {
    const r = classifyCriterion('See auth.test.ts for coverage');
    assert.ok(r.verified);
    assert.match(r.reason, /test.*spec file/);
  });

  it('VERIFIED: .spec. file path', () => {
    const r = classifyCriterion('Covered in login.spec.js');
    assert.ok(r.verified);
  });

  it('VERIFIED: verify: keyword', () => {
    const r = classifyCriterion('verify: run smoke tests');
    assert.ok(r.verified);
  });

  it('VERIFIED: verified by keyword', () => {
    const r = classifyCriterion('verified by integration.test.mjs');
    assert.ok(r.verified);
  });

  it('VERIFIED: test: label', () => {
    const r = classifyCriterion('test: ensure 200 is returned');
    assert.ok(r.verified);
  });

  it('VERIFIED: exit code phrase', () => {
    const r = classifyCriterion('script exits with exit code 0');
    assert.ok(r.verified);
  });

  it('VERIFIED: assert keyword', () => {
    const r = classifyCriterion('assert that the value is non-null');
    assert.ok(r.verified);
  });

  it('WISH: no markers', () => {
    const r = classifyCriterion('Works correctly and is fast');
    assert.ok(!r.verified);
    assert.match(r.reason, /no verification/);
  });

  it('WISH: vague description only', () => {
    const r = classifyCriterion('System should be reliable');
    assert.ok(!r.verified);
  });
});

// ---------------------------------------------------------------------------
// classifyAll
// ---------------------------------------------------------------------------

describe('classifyAll', () => {
  it('returns status field on each entry', () => {
    const criteria = [
      { line: 1, text: 'Run `test`', source: 'list' },
      { line: 2, text: 'Looks good', source: 'list' },
    ];
    const result = classifyAll(criteria);
    assert.equal(result[0].status, 'VERIFIED');
    assert.equal(result[1].status, 'WISH');
  });
});

// ---------------------------------------------------------------------------
// applyLlmDemotion — pure function, no network
// ---------------------------------------------------------------------------

describe('applyLlmDemotion', () => {
  it('demotes vacuous entries from VERIFIED to WISH', () => {
    const classified = [
      { line: 1, text: 'Run `test`', status: 'VERIFIED', reason: 'backtick' },
      { line: 2, text: 'Works: `check`', status: 'VERIFIED', reason: 'backtick' },
      { line: 3, text: 'No method', status: 'WISH', reason: 'no method' },
    ];
    // verifiedIndices = [0, 1] (indices into classified that are VERIFIED)
    const llmResult = {
      vacuous: [0], // index 0 in the VERIFIED subset = classified[0]
      reason: { '0': 'too vague' },
    };
    const verifiedIndices = [0, 1];
    const result = applyLlmDemotion(classified, llmResult, verifiedIndices);

    assert.equal(result[0].status, 'WISH');
    assert.equal(result[0].reason, 'too vague');
    assert.equal(result[1].status, 'VERIFIED'); // untouched
    assert.equal(result[2].status, 'WISH');     // was already WISH
  });

  it('does not modify entries not in the vacuous list', () => {
    const classified = [
      { line: 1, text: 'cmd: `run`', status: 'VERIFIED', reason: 'backtick' },
    ];
    const llmResult = { vacuous: [], reason: {} };
    const result = applyLlmDemotion(classified, llmResult, [0]);
    assert.equal(result[0].status, 'VERIFIED');
  });

  it('handles missing reason field gracefully', () => {
    const classified = [
      { line: 1, text: 'cmd: `run`', status: 'VERIFIED', reason: 'backtick' },
    ];
    const llmResult = { vacuous: [0] }; // no reason field
    const result = applyLlmDemotion(classified, llmResult, [0]);
    assert.equal(result[0].status, 'WISH');
    assert.ok(result[0].reason.includes('demoted'));
  });
});

// ---------------------------------------------------------------------------
// buildVacuousPrompt — prompt building (no network)
// ---------------------------------------------------------------------------

describe('buildVacuousPrompt', () => {
  it('includes all criteria indexed from 0', () => {
    const criteria = [
      { line: 1, text: 'Run `test`' },
      { line: 2, text: 'Works: `check`' },
    ];
    const prompt = buildVacuousPrompt(criteria);
    assert.ok(prompt.includes('0: Run `test`'));
    assert.ok(prompt.includes('1: Works: `check`'));
  });

  it('asks for JSON response with vacuous and reason keys', () => {
    const prompt = buildVacuousPrompt([{ line: 1, text: 'foo: `bar`' }]);
    assert.ok(prompt.includes('"vacuous"'));
    assert.ok(prompt.includes('"reason"'));
  });

  it('handles empty criteria list', () => {
    const prompt = buildVacuousPrompt([]);
    assert.ok(typeof prompt === 'string');
  });
});

// ---------------------------------------------------------------------------
// buildJsonResult / buildHumanReport
// ---------------------------------------------------------------------------

describe('buildJsonResult', () => {
  it('counts verified and wishes correctly', () => {
    const classified = [
      { line: 1, text: 'a', status: 'VERIFIED', reason: 'x' },
      { line: 2, text: 'b', status: 'WISH', reason: 'y' },
      { line: 3, text: 'c', status: 'VERIFIED', reason: 'z' },
    ];
    const result = buildJsonResult(classified, 'spec.md');
    assert.equal(result.total, 3);
    assert.equal(result.verified, 2);
    assert.equal(result.wishes, 1);
    assert.equal(result.file, 'spec.md');
  });
});

describe('buildHumanReport', () => {
  it('shows WARNING on empty criteria list', () => {
    const lines = buildHumanReport([], 'spec.md');
    assert.ok(lines.some(l => /WARNING/i.test(l)));
  });

  it('lists wishes section when wishes are present', () => {
    const classified = [
      { line: 1, text: 'no method here', status: 'WISH', reason: 'no method' },
    ];
    const lines = buildHumanReport(classified, 'spec.md');
    assert.ok(lines.some(l => l.includes('Wishes')));
  });
});

// ---------------------------------------------------------------------------
// Fixture-based integration tests
// ---------------------------------------------------------------------------

describe('fixture: all-verified.md', () => {
  it('parses all six criteria as VERIFIED', () => {

    const text = readFileSync(fixture('all-verified.md'), 'utf8');
    const criteria = classifyAll(parseCriteria(text));
    assert.equal(criteria.length, 6);
    assert.ok(criteria.every(c => c.status === 'VERIFIED'), 'all should be VERIFIED');
  });
});

describe('fixture: has-wishes.md', () => {
  it('identifies wishes (no verification method)', () => {

    const text = readFileSync(fixture('has-wishes.md'), 'utf8');
    const criteria = classifyAll(parseCriteria(text));
    const wishes = criteria.filter(c => c.status === 'WISH');
    assert.ok(wishes.length >= 2, `expected ≥2 wishes, got ${wishes.length}`);
    // "Checkout works correctly" and "Confirmation email is sent properly" and "The UI looks nice"
    // should be wishes.
    assert.ok(wishes.some(w => /works correctly/i.test(w.text)));
  });
});

describe('fixture: heading-variants.md', () => {
  it('captures items from Requirements, Definition of Done, and Success headings', () => {

    const text = readFileSync(fixture('heading-variants.md'), 'utf8');
    const criteria = parseCriteria(text);
    // Should NOT include the "Random heading" item.
    assert.ok(!criteria.some(c => c.text.includes('should NOT appear')));
    // Should have items from all three recognized headings.
    assert.ok(criteria.length >= 6);
  });
});

describe('fixture: must-should.md', () => {
  it('captures MUST/SHOULD standalone lines', () => {

    const text = readFileSync(fixture('must-should.md'), 'utf8');
    const criteria = parseCriteria(text);
    assert.ok(criteria.length >= 5, `expected ≥5, got ${criteria.length}`);
    const mustShould = criteria.filter(c => c.source === 'must-should');
    assert.ok(mustShould.length >= 3, 'should have MUST/SHOULD entries');
  });

  it('classifies MUST lines with no marker as WISH', () => {

    const text = readFileSync(fixture('must-should.md'), 'utf8');
    const criteria = classifyAll(parseCriteria(text));
    // "MUST have nice UI" and "MUST run fast" are wishes.
    const wishes = criteria.filter(c => c.status === 'WISH');
    assert.ok(wishes.length >= 2);
  });
});

describe('fixture: no-criteria.md', () => {
  it('returns empty array from parseCriteria', () => {

    const text = readFileSync(fixture('no-criteria.md'), 'utf8');
    const criteria = parseCriteria(text);
    assert.equal(criteria.length, 0);
  });
});

describe('fixture: vacuous-candidate.md — demotion round-trip', () => {
  it('all four criteria classify as VERIFIED before LLM pass', () => {
    const text = readFileSync(fixture('vacuous-candidate.md'), 'utf8');
    const classified = classifyAll(parseCriteria(text));
    assert.equal(classified.length, 4);
    assert.ok(classified.every(c => c.status === 'VERIFIED'), 'all should start VERIFIED');
  });

  it('applyLlmDemotion demotes vacuous entries using canned LLM response', () => {
    const text = readFileSync(fixture('vacuous-candidate.md'), 'utf8');
    const classified = classifyAll(parseCriteria(text));
    // verifiedIndices = [0,1,2,3] — all four are VERIFIED
    const verifiedIndices = classified
      .map((c, i) => (c.status === 'VERIFIED' ? i : -1))
      .filter(i => i !== -1);

    // Canned LLM response: indices 0,1,2 are vacuous; index 3 is specific
    const cannedLlmResult = {
      vacuous: [0, 1, 2],
      reason: {
        '0': 'just says "works correctly" — too vague',
        '1': 'verified by running the suite — does not name a test file or command',
        '2': 'test: check it works — no concrete assertion',
      },
    };

    const result = applyLlmDemotion(classified, cannedLlmResult, verifiedIndices);

    assert.equal(result[0].status, 'WISH');
    assert.match(result[0].reason, /too vague/);
    assert.equal(result[1].status, 'WISH');
    assert.match(result[1].reason, /test file/);
    assert.equal(result[2].status, 'WISH');
    assert.match(result[2].reason, /no concrete/);
    // criterion 3 (specific curl command) survives
    assert.equal(result[3].status, 'VERIFIED');
  });
});

// ---------------------------------------------------------------------------
// CLI smoke tests
// ---------------------------------------------------------------------------

describe('CLI: exit codes', () => {
  it('exits 1 when no file argument given', () => {
    const { code } = runCli([]);
    assert.equal(code, 1);
  });

  it('exits 1 when file does not exist', () => {
    const { code } = runCli(['/nonexistent/path/spec.md']);
    assert.equal(code, 1);
  });

  it('exits 0 for all-verified spec', () => {
    const { code } = runCli([fixture('all-verified.md')]);
    assert.equal(code, 0);
  });

  it('exits 2 for spec with wishes', () => {
    const { code } = runCli([fixture('has-wishes.md')]);
    assert.equal(code, 2);
  });

  it('exits 0 for no-criteria spec (warn but pass)', () => {
    const { code, stdout } = runCli([fixture('no-criteria.md')]);
    assert.equal(code, 0);
    assert.ok(stdout.includes('WARNING') || stdout.includes('no criteria'));
  });
});

describe('CLI: --json flag', () => {
  it('outputs valid JSON with all required fields', () => {
    const { stdout, code } = runCli(['--json', fixture('has-wishes.md')]);
    assert.equal(code, 2);
    const obj = JSON.parse(stdout);
    assert.ok('total' in obj);
    assert.ok('verified' in obj);
    assert.ok('wishes' in obj);
    assert.ok(Array.isArray(obj.criteria));
  });

  it('outputs valid JSON (no trailing text) when all criteria are verified', () => {
    const { stdout, code } = runCli(['--json', fixture('all-verified.md')]);
    assert.equal(code, 0);
    // Must not throw — no extra text after the JSON object
    const obj = JSON.parse(stdout);
    assert.equal(obj.wishes, 0);
    assert.ok(obj.verified > 0);
  });
});

describe('CLI: --prompt-only flag', () => {
  it('exits 0 and prints a prompt string', () => {
    const { code, stdout } = runCli(['--prompt-only', fixture('all-verified.md')]);
    assert.equal(code, 0);
    assert.ok(stdout.length > 0);
  });
});

describe('CLI: temp dir cleanup', () => {
  it('works with spec in a temp directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'spec-lint-test-'));
    try {
      const specPath = join(tmp, 'test-spec.md');
      writeFileSync(specPath, `## Acceptance Criteria\n- Item: \`check\`\n`);
      const { code } = runCli([specPath]);
      assert.equal(code, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
