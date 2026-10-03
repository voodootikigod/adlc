// gate-liveness: the ruleset must pin each required context to the source that
// is allowed to report it, and --branch must name exactly one branch of THIS
// repository. Both refusals fail closed; the committed declaration pins the
// source so the check cannot be dropped silently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredContexts, evaluate, main } from '../gate-liveness.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const committedGates = JSON.parse(readFileSync(join(REPO, 'docs/ci/required-gates.json'), 'utf8'));
const committedRuleset = JSON.parse(readFileSync(join(REPO, 'docs/github-rulesets/main-branch-ruleset.json'), 'utf8'));

const ACTIONS = 15368;
const CONTEXTS = ['test (18)', 'test (20)', 'test (22)', 'rails-guard', 'mutation-gate', 'gate'];

function rulesWith(sourceFor = () => ACTIONS) {
  return [{
    type: 'required_status_checks',
    parameters: {
      required_status_checks: CONTEXTS.map((context) => {
        const id = sourceFor(context);
        return id === undefined ? { context } : { context, integration_id: id };
      }),
    },
  }];
}

function run(argv, rules) {
  const out = [];
  const err = [];
  const calls = [];
  const code = main(argv, {
    runGh: (args) => { calls.push(args); return { ok: true, stdout: JSON.stringify(rules) }; },
    readGates: () => committedGates,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, out: out.join(''), err: err.join(''), calls };
}

describe('gate-liveness — required-context source pinning', () => {
  it('the committed declaration pins the same source the committed ruleset uses', () => {
    const pinned = committedRuleset.rules
      .filter((r) => r.type === 'required_status_checks')
      .flatMap((r) => r.parameters.required_status_checks.map((c) => c.integration_id));
    assert.ok(pinned.length > 0);
    for (const id of pinned) assert.equal(id, committedGates.integrationId);
    assert.equal(committedGates.integrationId, ACTIONS);
  });

  it('PASS when every declared context is pinned to the declared source', () => {
    const r = run([], rulesWith());
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /PASS/);
  });

  for (const [label, source] of [['unpinned (no integration_id)', undefined], ['null', null], ['another app', 99]]) {
    it(`DENY (exit 2) when "gate" is required but ${label}`, () => {
      const r = run([], rulesWith((c) => (c === 'gate' ? source : ACTIONS)));
      assert.equal(r.code, 2);
      assert.match(r.err, /DENY - .*not pinned to integration 15368.*: gate\b/);
      assert.doesNotMatch(r.err, /rails-guard/);
    });
  }

  it('--json reports the weakly sourced contexts', () => {
    const r = run(['--json'], rulesWith((c) => (c === 'mutation-gate' ? 7 : ACTIONS)));
    assert.equal(r.code, 2);
    const payload = JSON.parse(r.out);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.weakSource, ['mutation-gate']);
  });

  it('a context pinned correctly in one rule satisfies the check even if another rule repeats it unpinned', () => {
    const rules = [...rulesWith(), { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'gate' }] } }];
    const v = evaluate({ gates: committedGates, rules });
    assert.deepEqual(v.weakSource, []);
    assert.equal(v.ok, true);
  });

  it('without a declared integrationId, sources are not asserted', () => {
    const { integrationId, ...gates } = committedGates;
    assert.equal(integrationId, ACTIONS);
    const v = evaluate({ gates, rules: rulesWith(() => undefined) });
    assert.deepEqual(v.weakSource, []);
    assert.equal(v.ok, true);
  });

  for (const bad of [0, -1, 1.5, '15368', null, true]) {
    it(`a declared integrationId of ${JSON.stringify(bad)} is invalid (fail closed)`, () => {
      assert.throws(() => declaredContexts({ ...committedGates, integrationId: bad }), /integrationId/);
      const code = main([], {
        runGh: () => { throw new Error('must not call gh'); },
        readGates: () => ({ ...committedGates, integrationId: bad }),
        stdout: () => {},
        stderr: () => {},
      });
      assert.equal(code, 1);
    });
  }
});

describe('gate-liveness — --branch names one branch of this repository', () => {
  for (const branch of ['..', '../x', 'a/../b', '.', 'a/./b', 'a//b', '/main', 'main/', 'v1..2', 'feat/.hidden', '../../../../../repos/octocat/r/rules/branches/main']) {
    it(`--branch ${JSON.stringify(branch)} is refused without calling gh (exit 1)`, () => {
      const r = run(['--branch', branch], rulesWith());
      assert.equal(r.code, 1);
      assert.equal(r.calls.length, 0);
      assert.match(r.err, /invalid --branch/);
    });
  }

  for (const branch of ['main', 'release/1.x', 'feat/a.b', 'v1.2']) {
    it(`--branch ${JSON.stringify(branch)} is accepted`, () => {
      const r = run(['--branch', branch], rulesWith());
      assert.equal(r.code, 0, r.err);
      assert.equal(r.calls.length, 1);
      assert.ok(r.calls[0][1].includes(`/rules/branches/${branch}?`));
    });
  }
});
