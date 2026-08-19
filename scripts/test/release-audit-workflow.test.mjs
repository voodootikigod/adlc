// Tests for scripts/release-audit-workflow.mjs — the build step that turns the
// skill's markdown-fenced workflow into a runnable, self-contained script.
//
// The output is executed by the Workflow tool, so a defect here is not a bad
// report — it is a fan-out that never starts, after collection has already run and
// the background suite has been launched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, extractScript, buildScript, workflowMain, WORKFLOW_MD, INPUT_MARKER } from '../release-audit-workflow.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Compile the way the Workflow runtime does: inside an async wrapper. */
function compiles(source) {
  const body = source.replace('export const meta', 'const meta');
  return () => new vm.Script(`(async function (args, log, agent, pipeline, parallel) {\n${body}\n})`);
}

test('parseArgs reads both paths', () => {
  assert.deepEqual(parseArgs(['--input', 'a.json', '--out', 'b.mjs']), { input: 'a.json', out: 'b.mjs' });
});

test('extractScript returns the single javascript fence', () => {
  const code = extractScript('text\n```javascript\nconst a = 1\n```\nmore');
  assert.equal(code, 'const a = 1');
});

test('extractScript refuses an ambiguous document rather than guessing', () => {
  // Picking one of two blocks silently produces a workflow that looks plausible
  // and audits nothing.
  assert.throws(() => extractScript('```javascript\na\n```\n```javascript\nb\n```'), /found 2/);
  assert.throws(() => extractScript('no fences here'), /found 0/);
});

test('buildScript embeds the document and keeps the script intact', () => {
  const out = buildScript({ version: '1.11.0' }, `export const meta = {}\n${INPUT_MARKER}\nconst input = args || INPUT_DOC`);
  assert.match(out, /const INPUT_DOC = \{"version":"1\.11\.0"\}/);
  assert.match(out, /const input = args \|\| INPUT_DOC/);
  assert.match(out, /do not edit/);
});

test('buildScript leaves `export const meta` as the first statement', () => {
  // The Workflow runtime REJECTS a script whose first statement is anything else —
  // measured, not assumed: prepending the document produced "must be the FIRST
  // statement in the script" and the fan-out never launched. The document is
  // therefore injected at a marker that sits after meta.
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  const out = buildScript({ version: '1.11.0' }, script);
  const firstCode = out.split('\n').find((l) => l.trim() && !l.trim().startsWith('//'));
  assert.match(firstCode, /^export const meta = \{/);
});

test('buildScript declares INPUT_DOC before the line that reads it', () => {
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  const out = buildScript({ version: '1.11.0' }, script);
  assert.ok(out.indexOf('const INPUT_DOC =') < out.indexOf('|| INPUT_DOC'), 'a TDZ error would abort the run');
});

test('buildScript refuses a template with no marker rather than emitting a broken script', () => {
  assert.throws(() => buildScript({}, 'export const meta = {}\nconst input = INPUT_DOC'), /missing its/);
});

test('the committed workflow template carries the injection marker', () => {
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  assert.ok(script.includes(INPUT_MARKER));
  assert.ok(script.indexOf('export const meta') < script.indexOf(INPUT_MARKER), 'the marker must follow meta');
});

test('buildScript neutralises a script-closing sequence in issue text', () => {
  // Issue titles are written by anyone who can open an issue and are embedded
  // verbatim. `</script` is legal JSON and hostile in a script context.
  const out = buildScript({ units: [{ name: '</script><img src=x>' }] }, INPUT_MARKER);
  assert.ok(!out.includes('</script'), 'the raw sequence must not survive');
  assert.match(out, /\\u003c/);
});

test('buildScript neutralises the JSON-legal line terminators', () => {
  const out = buildScript({ t: 'a b c' }, INPUT_MARKER);
  assert.ok(!out.includes(' '));
  assert.ok(!out.includes(' '));
});

test('buildScript output still parses after escaping', () => {
  const out = buildScript({ t: 'a b', name: '</script>' }, `${INPUT_MARKER}\nconst input = INPUT_DOC`);
  assert.doesNotThrow(compiles(out));
});

test('an embedded document round-trips back to the original value', () => {
  const doc = { version: '1.11.0', units: [{ id: 'pkg:core', name: '</script> x' }] };
  const out = buildScript(doc, `${INPUT_MARKER}\nRESULT = INPUT_DOC`);
  const ctx = { RESULT: null };
  vm.createContext(ctx);
  new vm.Script(out).runInContext(ctx);
  // Compared as JSON, not deepEqual: the value is constructed inside another vm
  // realm, so its prototype differs and a strict deep-equal would fail on realm
  // identity rather than on content.
  assert.equal(JSON.stringify(ctx.RESULT), JSON.stringify(doc), 'escaping must not alter the data the agents see');
});

test('the committed workflow reference builds into a script that compiles', () => {
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  const built = buildScript({ version: '1.11.0', units: [], issues: { sweepBatches: [[]] }, probes: {} }, script);
  assert.doesNotThrow(compiles(built));
});

test('the built script prefers a supplied args over the embedded document', () => {
  const script = extractScript(readFileSync(join(ROOT, WORKFLOW_MD), 'utf8'));
  assert.match(script, /typeof args !== 'undefined' && args/);
  assert.match(script, /INPUT_DOC/);
});

test('workflowMain refuses to run without both paths', () => {
  const lines = [];
  assert.equal(workflowMain([], { log: (m) => lines.push(m) }), 1);
  assert.match(lines.join(' '), /usage:/);
});

test('workflowMain writes the built script and reports what it embedded', () => {
  const written = {};
  const lines = [];
  const code = workflowMain(['--input', 'in.json', '--out', 'out.mjs'], {
    readFile: (p) => (String(p).endsWith('in.json')
      ? JSON.stringify({ version: '1.11.0', units: [{ id: 'a' }, { id: 'b' }] })
      : readFileSync(join(ROOT, WORKFLOW_MD), 'utf8')),
    writeFile: (p, c) => { written[p] = c; },
    log: (m) => lines.push(m),
  });
  assert.equal(code, 0);
  assert.match(written['out.mjs'], /const INPUT_DOC = /);
  assert.match(lines.join(' '), /2 units/);
});
