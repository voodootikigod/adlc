// gate-fuzzing/test/suite-validation.test.mjs
// A gate that declares no surface or no claims can never be prosecuted:
// classify dismisses every candidate against it as out-of-scope / wrong-claim,
// and the run still reports clean. loadSuite must refuse such a suite, and the
// fan must never spend its budget on validity gates.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { loadSuite, validateSuiteGates, fuzzableGates } from '../lib/gate-adapter.mjs';
import { runLoop, splitByFuzzableTarget } from '../lib/loop.mjs';

const BIN = resolve(new URL('../bin/gate-fuzzing.mjs', import.meta.url).pathname);
const README = resolve(new URL('../README.md', import.meta.url).pathname);

const dirs = new Set();
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'gate-fuzzing-suite-validation-'));
  dirs.add(d);
  return d;
}

function writeSuite(suite) {
  const d = tmp();
  const p = join(d, 'suite.json');
  writeFileSync(p, typeof suite === 'string' ? suite : JSON.stringify(suite));
  return p;
}

const FUZZ = Object.freeze({
  name: 'rails-guard',
  run: ['node', 'x.mjs'],
  surface: ['test/**'],
  claims: ['freeze-integrity'],
});
const BUILD = Object.freeze({ name: 'build', run: ['npm', 'run', 'build'], validity: true });

/** The example suite from the README's "Gate suite format" section, parsed from the README itself. */
function readmeExampleSuite() {
  const md = readFileSync(README, 'utf8');
  const section = md.slice(md.indexOf('## Gate suite format'));
  const m = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, 'README must carry a JSON example suite under "Gate suite format"');
  return JSON.parse(m[1]);
}

// ── AC1: non-validity gate without surface / claims ─────────────────────────

const AC1_CASES = [
  ['surface absent', { name: 'g1', run: ['x'], claims: ['c'] }, /gate "g1": missing or empty "surface" \(required unless "validity": true\)/],
  ['surface empty', { name: 'g1', run: ['x'], surface: [], claims: ['c'] }, /gate "g1": missing or empty "surface"/],
  ['claims absent', { name: 'g1', run: ['x'], surface: ['s/**'] }, /gate "g1": missing or empty "claims" \(required unless "validity": true\)/],
  ['claims empty', { name: 'g1', run: ['x'], surface: ['s/**'], claims: [] }, /gate "g1": missing or empty "claims"/],
  ['surface not an array', { name: 'g1', run: ['x'], surface: 's/**', claims: ['c'] }, /gate "g1": missing or empty "surface"/],
  ['surface entry empty string', { name: 'g1', run: ['x'], surface: [''], claims: ['c'] }, /gate "g1": "surface" must contain only non-empty strings/],
  ['claims entry not a string', { name: 'g1', run: ['x'], surface: ['s'], claims: [3] }, /gate "g1": "claims" must contain only non-empty strings/],
];

for (const [label, gate, re] of AC1_CASES) {
  test(`AC1 loadSuite rejects a non-validity gate: ${label}`, () => {
    const p = writeSuite({ gates: [gate] });
    assert.throws(() => loadSuite(p), (e) => {
      assert.match(e.message, re);
      assert.ok(e.message.includes(resolve(p)), 'message is prefixed with the suite path');
      return true;
    });
  });
}

test('AC1 validateSuiteGates reports each problem, naming the gate', () => {
  const problems = validateSuiteGates([FUZZ, { name: 'g2', run: ['x'] }]);
  assert.deepEqual(problems, [
    'gate "g2": missing or empty "surface" (required unless "validity": true)',
    'gate "g2": missing or empty "claims" (required unless "validity": true)',
  ]);
});

test('AC1 a validity gate needs neither surface nor claims', () => {
  assert.deepEqual(validateSuiteGates([FUZZ, BUILD]), []);
});

test('AC1 validity must be exactly true to exempt a gate', () => {
  const problems = validateSuiteGates([FUZZ, { name: 'b', run: ['x'], validity: 'true' }]);
  assert.ok(problems.some((p) => p.startsWith('gate "b": missing or empty "surface"')), problems.join('\n'));
});

test('AC1 loadSuite joins every problem into one error', () => {
  const p = writeSuite({ gates: [{ name: 'a', run: ['x'] }] });
  assert.throws(() => loadSuite(p), (e) => {
    assert.match(e.message, /"surface"/);
    assert.match(e.message, /"claims"/);
    return true;
  });
});

// ── AC2: all-validity suite; missing name / run ─────────────────────────────

test('AC2 a suite whose gates are all validity gates is rejected', () => {
  const problems = validateSuiteGates([BUILD, { ...BUILD, name: 'lint' }]);
  assert.deepEqual(problems, ['suite has no fuzzable gate: every gate is a validity gate (at least one gate must omit "validity": true)']);
  const p = writeSuite({ gates: [BUILD] });
  assert.throws(() => loadSuite(p), /suite has no fuzzable gate/);
});

test('AC2 a gate missing name is rejected and named by index', () => {
  assert.deepEqual(
    validateSuiteGates([FUZZ, { run: ['x'], surface: ['s'], claims: ['c'] }]),
    ['gate #1: missing or empty "name"'],
  );
  assert.deepEqual(
    validateSuiteGates([{ ...FUZZ, name: '' }]),
    ['gate #0: missing or empty "name"'],
  );
  assert.deepEqual(
    validateSuiteGates([{ ...FUZZ, name: 7 }]),
    ['gate #0: missing or empty "name"'],
  );
});

test('AC2 a gate missing run or with an empty run is rejected', () => {
  assert.deepEqual(validateSuiteGates([{ ...FUZZ, run: undefined }]), ['gate "rails-guard": missing or empty "run" (argv array)']);
  assert.deepEqual(validateSuiteGates([{ ...FUZZ, run: [] }]), ['gate "rails-guard": missing or empty "run" (argv array)']);
  assert.deepEqual(validateSuiteGates([{ ...FUZZ, run: 'node x.mjs' }]), ['gate "rails-guard": missing or empty "run" (argv array)']);
});

test('AC2 a gate that is not a plain object is rejected', () => {
  assert.deepEqual(validateSuiteGates([FUZZ, null]), ['gate #1: must be an object']);
  assert.deepEqual(validateSuiteGates([FUZZ, ['x']]), ['gate #1: must be an object']);
  assert.deepEqual(validateSuiteGates([FUZZ, 'build']), ['gate #1: must be an object']);
});

test('AC2 validateSuiteGates does not mutate its input', () => {
  const gates = [{ name: 'g', run: ['x'] }];
  const snapshot = JSON.stringify(gates);
  validateSuiteGates(gates);
  assert.equal(JSON.stringify(gates), snapshot);
});

// ── AC3: CLI contract on an invalid suite ───────────────────────────────────

test('AC3 CLI --prompt-only with an invalid suite exits 1, problem on stderr, nothing on stdout', () => {
  const p = writeSuite({ gates: [{ name: 'nosurface', run: ['x'], claims: ['c'] }] });
  const r = spawnSync(process.execPath, [BIN, '--suite', p, '--prompt-only'], {
    cwd: tmp(),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /gate "nosurface": missing or empty "surface"/);
});

// ── AC4: fan targets only fuzzable gates ────────────────────────────────────

test('AC4 fuzzableGates excludes validity gates and keeps order', () => {
  const other = { ...FUZZ, name: 'other' };
  assert.deepEqual(fuzzableGates({ gates: [BUILD, FUZZ, other] }).map((g) => g.name), ['rails-guard', 'other']);
  assert.deepEqual(fuzzableGates({ gates: [BUILD] }), []);
});

test('AC4 --prompt-only output for the README example suite never targets the build gate', () => {
  const p = writeSuite(readmeExampleSuite());
  const r = spawnSync(process.execPath, [BIN, '--suite', p, '--prompt-only', '--n', '4'], {
    cwd: tmp(),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const headers = r.stdout.match(/^=== Fan instance .*$/gm) ?? [];
  assert.equal(headers.length, 4, r.stdout);
  for (const h of headers) assert.match(h, /\| Gate: rails-guard \|/);
  assert.doesNotMatch(r.stdout, /\| Gate: build \|/);
});

// ── AC5: the README example suite still loads ───────────────────────────────

test('AC5 the README example suite loads unchanged', () => {
  const example = readmeExampleSuite();
  const p = writeSuite(example);
  assert.deepEqual(loadSuite(p), example);
  assert.deepEqual(validateSuiteGates(example.gates), []);
});

// ── duplicate gate names ────────────────────────────────────────────────────

test('duplicate fuzzable gate names are rejected', () => {
  const problems = validateSuiteGates([FUZZ, { ...FUZZ, surface: ['other/**'] }]);
  assert.deepEqual(problems, ['gate "rails-guard": duplicate name (gate names must be unique)']);
});

test('a validity gate sharing a fuzzable gate\'s name is rejected, once per name', () => {
  const problems = validateSuiteGates([FUZZ, { ...BUILD, name: 'rails-guard' }, { ...BUILD, name: 'rails-guard' }]);
  assert.deepEqual(problems, ['gate "rails-guard": duplicate name (gate names must be unique)']);
});

test('distinct names are not flagged as duplicates', () => {
  assert.deepEqual(validateSuiteGates([FUZZ, BUILD, { ...FUZZ, name: 'rails-guard-2' }]), []);
});

test('CLI with a duplicate-name suite exits 1 before printing prompts', () => {
  const p = writeSuite({ gates: [FUZZ, { ...FUZZ }] });
  const r = spawnSync(process.execPath, [BIN, '--suite', p, '--prompt-only'], {
    cwd: tmp(),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /gate "rails-guard": duplicate name/);
});

// ── a model-chosen target outside the fuzzable gates never earns a dry round ─

function fanTargeting(target) {
  return async () => [{
    ok: true,
    value: JSON.stringify({
      id: `cand-${target}`,
      strategy: 'base-ref-window',
      target,
      claimKind: 'freeze-integrity',
      rationale: 'off target',
      diff: 'diff --git a/unrelated b/unrelated\n+// noop',
      witnessProposal: { cmd: 'node', args: ['--test'] },
      setup: [],
    }),
  }];
}

for (const target of ['build', 'no-such-gate']) {
  test(`runLoop: candidates targeting "${target}" are rejected, never classified, never dry`, async () => {
    let classified = 0;
    const result = await runLoop([FUZZ, BUILD], { dir: '/fake' }, {
      fanFn: fanTargeting(target),
      classifyFn: () => { classified++; return { result: 'out-of-scope', reason: 'off surface' }; },
      maxRounds: 4,
      dryRounds: 2,
      tokenBudget: 1_000_000,
      cloneDir: '/fake/clone',
      n: 1,
    });
    assert.equal(classified, 0);
    assert.notEqual(result.stoppedBy, 'dry');
    assert.equal(result.inconclusiveRounds, 4);
    assert.equal(result.candidatesRejected['invalid:target-not-fuzzable'], 4);
  });
}

test('runLoop: a candidate targeting the fuzzable gate is still classified', async () => {
  let classified = 0;
  const result = await runLoop([FUZZ, BUILD], { dir: '/fake' }, {
    fanFn: fanTargeting('rails-guard'),
    classifyFn: () => { classified++; return { result: 'caught', reason: 'gate caught' }; },
    maxRounds: 4,
    dryRounds: 2,
    tokenBudget: 1_000_000,
    cloneDir: '/fake/clone',
    n: 1,
  });
  assert.equal(classified, 2);
  assert.equal(result.stoppedBy, 'dry');
});

test('splitByFuzzableTarget keeps order and counts the rest', () => {
  const cs = [{ target: 'a' }, { target: 'b' }, { target: 'a' }];
  assert.deepEqual(splitByFuzzableTarget(cs, new Set(['a'])), { targeted: [cs[0], cs[2]], offTarget: 1 });
});
