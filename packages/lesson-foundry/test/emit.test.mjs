// Tests for file emission shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLintDescriptor, buildCheckScript, buildSkillStub, buildSpecGapLine, planEmissions } from '../lib/emit.mjs';

// ---------------------------------------------------------------------------
// buildLintDescriptor
// ---------------------------------------------------------------------------
test('buildLintDescriptor: returns valid JSON descriptor shape', () => {
  const findings = [{ desc: 'Found "TODO" comment in production code', category: 'security' }];
  const { path, content } = buildLintDescriptor('todo-in-prod', findings);

  assert(path.endsWith('.lint.json'));
  const parsed = JSON.parse(content);
  assert.strictEqual(typeof parsed.name, 'string');
  assert.strictEqual(typeof parsed.pattern, 'string');
  assert(Array.isArray(parsed.paths));
  assert.strictEqual(typeof parsed.message, 'string');
  assert(parsed.paths.includes('**'));
});

test('buildLintDescriptor: pattern is escaped literal when literal found', () => {
  const findings = [{ desc: 'Use "strict" mode everywhere' }];
  const { content } = buildLintDescriptor('strict-mode', findings);
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.pattern, 'strict');
});

// ---------------------------------------------------------------------------
// buildCheckScript
// ---------------------------------------------------------------------------
test('buildCheckScript: returns runnable .mjs script', () => {
  const findings = [{ desc: 'Found "eval" usage in code', category: 'security' }];
  const { path, content } = buildCheckScript('no-eval', findings);

  assert(path.endsWith('.mjs'));
  assert(content.includes('process.exit(0)'));
  assert(content.includes('process.exit(2)'));
  assert(content.includes('import'));
  assert(content.includes('grep'));
});

test('buildCheckScript: script name matches cluster name', () => {
  const findings = [{ desc: 'test finding', category: 'security' }];
  const { path } = buildCheckScript('my-cluster', findings);
  assert.strictEqual(path, 'check-my-cluster.mjs');
});

// ---------------------------------------------------------------------------
// buildSkillStub
// ---------------------------------------------------------------------------
test('buildSkillStub: returns SKILL.md with frontmatter', () => {
  const findings = [
    { desc: 'missing error handling in async functions', category: 'convention', file: 'src/api.mjs', line: 42 },
    { desc: 'no error handling for async call', category: 'convention', file: 'src/db.mjs', line: 10 },
  ];
  const { path, content } = buildSkillStub('async-error-handling', findings, null);

  assert(path.endsWith('.SKILL.md'));
  assert(content.startsWith('---'));
  assert(content.includes('name:'));
  assert(content.includes('description:'));
  assert(content.includes('mined from 2 findings') || content.includes('Mined from 2 finding'));
  assert(content.includes('src/api.mjs') || content.includes('api'));
});

test('buildSkillStub: uses LLM refinement when provided', () => {
  const findings = [{ desc: 'some pattern issue', category: 'pattern' }];
  const refinement = {
    name: 'refined-name',
    description: 'A refined description',
    rule: 'Always do the right thing',
  };
  const { content } = buildSkillStub('raw-name', findings, refinement);
  assert(content.includes('refined-name'));
  assert(content.includes('A refined description'));
  assert(content.includes('Always do the right thing'));
});

// ---------------------------------------------------------------------------
// buildSpecGapLine
// ---------------------------------------------------------------------------
test('buildSpecGapLine: returns markdown checkbox line', () => {
  const findings = [{ desc: 'unclear data retention policy', category: 'security' }];
  const line = buildSpecGapLine('data-retention', findings);
  assert(line.startsWith('- [ ]'));
  assert(line.includes('data-retention'));
  assert(line.includes('1 finding'));
});

test('buildSpecGapLine: pluralizes findings correctly', () => {
  const findings = [
    { desc: 'unclear policy', category: 'security' },
    { desc: 'unclear policy', category: 'security' },
  ];
  const line = buildSpecGapLine('policy-gap', findings);
  assert(line.includes('2 findings'));
});

// ---------------------------------------------------------------------------
// planEmissions
// ---------------------------------------------------------------------------
test('planEmissions: lint cluster produces two files', () => {
  const clusters = [
    { name: 'todo-lint', indices: [0], size: 1, route: 'lint', sample: 'TODO comment' },
  ];
  const findings = [{ desc: 'Found "TODO" in code', category: 'security' }];
  const plan = planEmissions(clusters, findings, '/tmp/out');

  const entry = plan.find((p) => p.cluster === clusters[0]);
  assert(entry);
  assert.strictEqual(entry.route, 'lint');
  assert.strictEqual(entry.files.length, 2);
  assert(entry.files.some((f) => f.path.endsWith('.lint.json')));
  assert(entry.files.some((f) => f.path.endsWith('.mjs')));
});

test('planEmissions: skill cluster produces one SKILL.md', () => {
  const clusters = [
    { name: 'async-errors', indices: [0], size: 1, route: 'skill', sample: 'missing error handling' },
  ];
  const findings = [{ desc: 'missing error handling', category: 'convention' }];
  const plan = planEmissions(clusters, findings, '/tmp/out');

  const entry = plan.find((p) => p.cluster === clusters[0]);
  assert(entry);
  assert.strictEqual(entry.route, 'skill');
  assert.strictEqual(entry.files.length, 1);
  assert(entry.files[0].path.endsWith('.SKILL.md'));
});

test('planEmissions: spec-gap cluster produces interrogation template entry', () => {
  const clusters = [
    { name: 'data-retention', indices: [0], size: 1, route: 'spec-gap', sample: 'unclear policy' },
  ];
  const findings = [{ desc: 'unclear data retention policy', category: 'unknown' }];
  const plan = planEmissions(clusters, findings, '/tmp/out');

  // Should have a spec-gap-template entry
  const template = plan.find((p) => p.route === 'spec-gap-template');
  assert(template);
  assert(template.files[0].path.includes('interrogation-template.md'));
  assert(template.files[0].content.includes('data-retention'));
});

test('planEmissions: outDir prefix applied to all file paths', () => {
  const clusters = [
    { name: 'test-cluster', indices: [0], size: 1, route: 'skill', sample: 'desc' },
  ];
  const findings = [{ desc: 'test', category: 'convention' }];
  const plan = planEmissions(clusters, findings, '/custom/out-dir');

  const entry = plan.find((p) => p.cluster === clusters[0]);
  assert(entry.files.every((f) => f.path.startsWith('/custom/out-dir')));
});

test('planEmissions: empty clusters returns empty plan', () => {
  const plan = planEmissions([], [], '/tmp/out');
  assert.deepStrictEqual(plan, []);
});
