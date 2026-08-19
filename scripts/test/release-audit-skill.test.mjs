// Tests for the /release-audit skill assets.
//
// The workflow script is JavaScript that lives inside a markdown fence, so no
// linter, type checker or test runner sees it by default. A syntax error there
// fails at fan-out — AFTER collection has run and the background suite has been
// started — which is the most expensive moment to discover it. These tests give
// the fence the same syntax guarantee a real source file gets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'release-audit');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const WORKFLOW_MD = join(SKILL_DIR, 'references', 'workflow-script.md');

/** The single ```javascript fence in the workflow reference. */
export function extractScript(markdown) {
  const blocks = [...String(markdown).matchAll(/```javascript\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  return blocks;
}

test('the skill and its workflow reference exist', () => {
  assert.ok(existsSync(SKILL_MD), 'SKILL.md must exist');
  assert.ok(existsSync(WORKFLOW_MD), 'references/workflow-script.md must exist');
});

test('SKILL.md declares the frontmatter the slash command needs', () => {
  const text = readFileSync(SKILL_MD, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(fm, 'SKILL.md must open with YAML frontmatter');
  assert.match(fm[1], /^name: release-audit$/m);
  assert.match(fm[1], /^user-invocable: true$/m);
  assert.match(fm[1], /^argument-hint:/m);
  assert.match(fm[1], /description:/);
});

test('SKILL.md documents every flag the collector actually parses', () => {
  const text = readFileSync(SKILL_MD, 'utf8');
  for (const flag of ['--since', '--packages', '--skip-issues']) {
    assert.ok(text.includes(flag), `SKILL.md must document ${flag}`);
  }
});

test('the workflow reference holds exactly one javascript block', () => {
  const blocks = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.equal(blocks.length, 1, 'ambiguity about which block to pass is itself a defect');
});

test('the workflow script parses as a workflow body', () => {
  // The runtime evaluates the script inside an async wrapper, which is why a
  // top-level `return` is legal there and would be a SyntaxError in a bare
  // module. Compile it the way the runtime sees it.
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  const body = code.replace('export const meta', 'const meta');
  assert.doesNotThrow(() => new vm.Script(`(async function (args, log, agent, pipeline, parallel) {\n${body}\n})`));
});

test('the workflow script declares meta with both phases', () => {
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /export const meta = \{/);
  assert.match(code, /name: 'release-audit'/);
  assert.match(code, /title: 'Audit'/);
  assert.match(code, /title: 'Verify'/);
});

test('the workflow script forces a schema on every agent call', () => {
  // An agent without a schema returns prose, and prose cannot be bucketed,
  // grounded or counted — the whole verdict would degrade to a summary.
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  const calls = [...code.matchAll(/agent\(/g)];
  assert.ok(calls.length >= 2, 'expected a unit agent and a refute agent');
  const schemaUses = [...code.matchAll(/schema: (REPORT|VERDICT)/g)];
  assert.equal(schemaUses.length, calls.length, 'every agent() call must pass a schema');
});

test('the report schema requires the anti-hollow and grounding fields', () => {
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /required: \['unit', 'files_examined', 'findings', 'issue_verdicts', 'notes'\]/);
  assert.match(code, /evidence: \{ type: 'string'/);
});

test('the finding schema requires all three blocker-test booleans', () => {
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /required: \['user_hits_it', 'needs_another_release', 'worse_than_status_quo'\]/);
});

test('the workflow skips the suite agents on a filtered run', () => {
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /const FILTERED = input\.filtered === true/);
  assert.match(code, /FILTERED \? \[\] : \[\.\.\.SUITE_SPECS, \.\.\.SWEEP_SPECS\]/);
});

test('the fixed suite agent ids in the workflow match the ones the synthesizer expects', async () => {
  // These two lists are the coverage contract: the synthesizer forces NO-GO for
  // any expected unit that produced no report, so a rename on one side alone
  // would make every run fail closed for a reason nobody could find.
  const { SUITE_UNITS } = await import('../release-audit-synthesize.mjs');
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  for (const id of SUITE_UNITS) {
    assert.ok(code.includes(`id: '${id}'`), `workflow must define the ${id} agent`);
    assert.ok(code.includes(`unit exactly "${id}"`), `workflow must pin ${id}'s reported unit id`);
  }
});

test('the workflow shards the issue sweep with ids the synthesizer can predict', async () => {
  // The shard count is data, so the two sides agree by FORMULA rather than by a
  // shared constant. If either spelling drifts, every run reports a missing unit.
  const { expectedSuiteUnits } = await import('../release-audit-synthesize.mjs');
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /input\.issues\?\.sweepBatches/);
  assert.match(code, /suite:issues:\$\{idx \+ 1\}/);
  assert.deepEqual(
    expectedSuiteUnits({ issues: { sweepBatches: [[], []] } }).filter((u) => u.startsWith('suite:issues:')),
    ['suite:issues:1', 'suite:issues:2'],
  );
});

test('the sweep prompt tells the shard to open the code, not judge from issue text', () => {
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /Do not answer from the issue text alone/);
});

test('the workflow prompts the plugin units about their hook surface', () => {
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /u\.kind === 'plugin'/);
  assert.match(code, /HOST PLUGIN/);
});

test('the refute prompt asks to break the claim, not to confirm it', () => {
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /Your job is to REFUTE it/);
  assert.match(code, /Do not refuse to refute/);
});

test('the workflow reads sweepBatches defensively, like the synthesizer does', () => {
  // An input document without an `issues` object must not crash the script before
  // a single unit agent is dispatched — the collector has already run by then.
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  assert.match(code, /input\.issues\?\.sweepBatches/);
  assert.ok(!/input\.issues\.sweepBatches/.test(code), 'no unguarded input.issues.sweepBatches access may remain');
});

test('the unit projection provides every unit field the workflow prompts read', async () => {
  // The projection exists to keep `args` small, and its failure mode is quiet: a
  // field dropped here is `undefined` inside a template literal, which renders as
  // the string "undefined" in a prompt rather than throwing. So the contract is
  // asserted mechanically against what the script actually references.
  const { workflowArgs } = await import('../release-audit-collect.mjs');
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  const referenced = new Set([...code.matchAll(/\bu\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const projected = workflowArgs({
    units: [{ id: 'x', kind: 'package', dir: 'd', name: 'n', version: '1', published: true,
      manifest: null, bin: null, filesField: [], dependencies: {}, engines: {}, hasTests: true,
      fileCount: 1, bytes: 1, churn: {}, issues: [], files: ['f'] }],
  }).units[0];
  const missing = [...referenced].filter((f) => !(f in projected));
  assert.deepEqual(missing, [], `workflowArgs must project: ${missing.join(', ')}`);
});

test('the projection provides every ISSUE field the workflow prompts render', async () => {
  // Issue records are the bulk of `args`, so fields are trimmed aggressively — and
  // a trimmed field that a prompt still renders would print "undefined" beside a
  // real issue number, which reads as data rather than as a bug.
  const { workflowArgs } = await import('../release-audit-collect.mjs');
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  const referenced = new Set([...code.matchAll(/\bi\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const full = { number: 1, title: 't', url: 'u', labels: [], routedVia: 'v', routedTo: null, excerpt: 'e' };
  const projected = workflowArgs({ units: [{ issues: [full] }], issues: { sweepBatches: [[full]] } });
  for (const record of [projected.units[0].issues[0], projected.issues.sweepBatches[0][0]]) {
    const missing = [...referenced].filter((f) => !(f in record));
    assert.deepEqual(missing, [], `issue projection must keep: ${missing.join(', ')}`);
  }
});

test('the top-level projection provides every input field the workflow reads', async () => {
  const { workflowArgs } = await import('../release-audit-collect.mjs');
  const [code] = extractScript(readFileSync(WORKFLOW_MD, 'utf8'));
  const referenced = new Set([...code.matchAll(/\binput\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const projected = workflowArgs({ version: '1', currentVersion: '1', since: 'v1' });
  const missing = [...referenced].filter((f) => !(f in projected));
  assert.deepEqual(missing, [], `workflowArgs must project: ${missing.join(', ')}`);
});
