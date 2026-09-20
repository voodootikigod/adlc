// scripts/test/gate-liveness.test.mjs — tests for gate-liveness meta-gate (AC1-AC9, AC13).
//
// Conforms to ADLC standards:
// - Compatible with Node 18+ (no import.meta.dirname, read JSON via readFileSync)
// - Hermetic: no network calls, no temp directory creation
// - Full coverage of pure evaluators and CLI main()

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SCRIPT_PATH = join(REPO, 'scripts', 'gate-liveness.mjs');
const REQUIRED_GATES_PATH = join(REPO, 'docs', 'ci', 'required-gates.json');
const MAIN_RULESET_PATH = join(REPO, 'docs', 'github-rulesets', 'main-branch-ruleset.json');

const {
  declaredContexts,
  requiredContexts,
  evaluate,
  defaultRunGh,
  main,
} = await import('../gate-liveness.mjs');

const { blockingPrefixOf, BLOCKING_PREFIXES } = await import('../../packages/autopilot/lib/ci.mjs');

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const committedGates = loadJson(REQUIRED_GATES_PATH);
const committedRuleset = loadJson(MAIN_RULESET_PATH);

const liveRulesPayload = [
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [
        { context: 'test (18)', integration_id: 15368 },
        { context: 'test (20)', integration_id: 15368 },
        { context: 'test (22)', integration_id: 15368 },
      ],
    },
  },
  {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 0,
      require_code_owner_review: false,
    },
  },
];

const fullRulesPayload = [
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [
        { context: 'test (18)', integration_id: 15368 },
        { context: 'test (20)', integration_id: 15368 },
        { context: 'test (22)', integration_id: 15368 },
        { context: 'rails-guard', integration_id: 15368 },
        { context: 'mutation-gate', integration_id: 15368 },
        { context: 'gate', integration_id: 15368 },
      ],
    },
  },
  {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 0,
      require_code_owner_review: false,
    },
  },
];

describe('declaredContexts', () => {
  it('extracts blocking contexts in file order', () => {
    const contexts = declaredContexts(committedGates);
    assert.deepEqual(contexts, [
      'test (18)',
      'test (20)',
      'test (22)',
      'rails-guard',
      'mutation-gate',
      'gate',
    ]);
  });

  it('throws on non-object or null document', () => {
    assert.throws(() => declaredContexts(null), /not an object/i);
    assert.throws(() => declaredContexts('primitive'), /not an object/i);
  });

  it('throws on missing or non-object workflows', () => {
    assert.throws(() => declaredContexts({ ...committedGates, workflows: null }), /missing workflows/i);
    assert.throws(() => declaredContexts({ ...committedGates, workflows: 'string' }), /missing workflows/i);
  });

  it('throws on non-object workflow entry or job entry', () => {
    assert.throws(
      () => declaredContexts({ ...committedGates, workflows: { 'wf.yml': null } }),
      /not an object/i,
    );
    assert.throws(
      () => declaredContexts({ ...committedGates, workflows: { 'wf.yml': 'string' } }),
      /not an object/i,
    );
    assert.throws(
      () => declaredContexts({ ...committedGates, workflows: { 'wf.yml': { job1: null } } }),
      /not an object/i,
    );
    assert.throws(
      () => declaredContexts({ ...committedGates, workflows: { 'wf.yml': { job1: 'string' } } }),
      /not an object/i,
    );
  });

  it('throws on non-boolean blocking or invalid context string', () => {
    assert.throws(
      () => declaredContexts({ ...committedGates, workflows: { 'wf.yml': { job1: { blocking: 'yes' } } } }),
      /must specify boolean blocking/i,
    );
    assert.throws(
      () => declaredContexts({ ...committedGates, workflows: { 'wf.yml': { job1: { blocking: true, contexts: [''] } } } }),
      /invalid context/i,
    );
    assert.throws(
      () => declaredContexts({ ...committedGates, workflows: { 'wf.yml': { job1: { blocking: true, contexts: [123] } } } }),
      /invalid context/i,
    );
  });

  it('throws on invalid pullRequestReview mode', () => {
    assert.throws(
      () => declaredContexts({ ...committedGates, pullRequestReview: 'invalid' }),
      /invalid pullRequestReview/i,
    );
  });

  it('throws on blocking job without non-empty contexts array', () => {
    const bad = {
      ...committedGates,
      workflows: {
        '.github/workflows/ci.yml': {
          badJob: { blocking: true, contexts: [] },
        },
      },
    };
    assert.throws(() => declaredContexts(bad), /non-empty contexts array/i);
  });

  it('throws on non-blocking job without non-empty why', () => {
    const bad = {
      ...committedGates,
      workflows: {
        '.github/workflows/ci.yml': {
          badJob: { blocking: false, why: '' },
        },
      },
    };
    assert.throws(() => declaredContexts(bad), /non-empty why/i);
  });

  it('throws on duplicate context', () => {
    const bad = {
      ...committedGates,
      workflows: {
        '.github/workflows/ci.yml': {
          job1: { blocking: true, contexts: ['dup'] },
          job2: { blocking: true, contexts: ['dup'] },
        },
      },
    };
    assert.throws(() => declaredContexts(bad), /duplicate context/i);
  });

  it('throws on empty blocking contexts', () => {
    const bad = {
      branch: 'main',
      pullRequestReview: 'none',
      workflows: {
        '.github/workflows/ci.yml': {
          job1: { blocking: false, why: 'advisory' },
        },
      },
    };
    assert.throws(() => declaredContexts(bad), /no blocking context/i);
  });
});

describe('requiredContexts', () => {
  it('extracts contexts from required_status_checks rules', () => {
    const contexts = requiredContexts(fullRulesPayload);
    assert.deepEqual(contexts, [
      'test (18)',
      'test (20)',
      'test (22)',
      'rails-guard',
      'mutation-gate',
      'gate',
    ]);
  });

  it('unions multiple required_status_checks rules and skips duplicates', () => {
    const rules = [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'a' }, { context: 'b' }] },
      },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'b' }, { context: 'c' }] },
      },
    ];
    assert.deepEqual(requiredContexts(rules), ['a', 'b', 'c']);
  });

  it('throws when rules is not an array', () => {
    assert.throws(() => requiredContexts(null), /must be an array/i);
    assert.throws(() => requiredContexts('string'), /must be an array/i);
    assert.throws(() => requiredContexts({}), /must be an array/i);
  });

  it('throws when required_status_checks is not an array', () => {
    const bad = [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: 'not-an-array' },
      },
    ];
    assert.throws(() => requiredContexts(bad), /not an array/i);
  });
});

describe('evaluate', () => {
  it('AC1: returns missing contexts for live ruleset', () => {
    const res = evaluate({ gates: committedGates, rules: liveRulesPayload });
    assert.equal(res.ok, false);
    assert.deepEqual(res.missing, ['rails-guard', 'mutation-gate', 'gate']);
    assert.deepEqual(res.undeclared, []);
    assert.equal(res.review.ok, true);
    assert.deepEqual(res.review.observed, liveRulesPayload[1].parameters);
    assert.ok(!Array.isArray(res.review.observed));

    const res2 = evaluate({
      gates: committedGates,
      rules: [...liveRulesPayload, liveRulesPayload[1]],
    });
    assert.ok(Array.isArray(res2.review.observed));
    assert.equal(res2.review.observed.length, 2);
  });

  it('AC3: returns ok: true when live set equals declared set', () => {
    const res = evaluate({ gates: committedGates, rules: fullRulesPayload });
    assert.equal(res.ok, true);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.undeclared, []);
  });

  it('AC3: returns ok: false and undeclared when ruleset requires extra context', () => {
    const extraRules = [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            ...fullRulesPayload[0].parameters.required_status_checks,
            { context: 'unexpected-check' },
          ],
        },
      },
      fullRulesPayload[1],
    ];
    const res = evaluate({ gates: committedGates, rules: extraRules });
    assert.equal(res.ok, false);
    assert.deepEqual(res.undeclared, ['unexpected-check']);
  });

  it('AC3: empty rules array evaluates to all declared contexts missing', () => {
    const res = evaluate({ gates: committedGates, rules: [] });
    assert.equal(res.ok, false);
    assert.deepEqual(res.missing, declaredContexts(committedGates));
  });

  it('AC4: pullRequestReview modes evaluate correctly', () => {
    // none mode
    const resNone = evaluate({
      gates: { ...committedGates, pullRequestReview: 'none' },
      rules: fullRulesPayload,
    });
    assert.equal(resNone.review.ok, true);
    assert.equal(resNone.review.mode, 'none');

    // code-owner mode unmet
    const resOwnerUnmet = evaluate({
      gates: { ...committedGates, pullRequestReview: 'code-owner' },
      rules: fullRulesPayload,
    });
    assert.equal(resOwnerUnmet.review.ok, false);
    assert.equal(resOwnerUnmet.ok, false);

    // code-owner mode met
    const ownerMetRules = [
      fullRulesPayload[0],
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true, required_approving_review_count: 0 },
      },
    ];
    const resOwnerMet = evaluate({
      gates: { ...committedGates, pullRequestReview: 'code-owner' },
      rules: ownerMetRules,
    });
    assert.equal(resOwnerMet.review.ok, true);
    assert.equal(resOwnerMet.ok, true);

    // approving mode unmet
    const resApproveUnmet = evaluate({
      gates: { ...committedGates, pullRequestReview: 'approving' },
      rules: fullRulesPayload,
    });
    assert.equal(resApproveUnmet.review.ok, false);

    // approving mode met
    const approveMetRules = [
      fullRulesPayload[0],
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: false, required_approving_review_count: 1 },
      },
    ];
    const resApproveMet = evaluate({
      gates: { ...committedGates, pullRequestReview: 'approving' },
      rules: approveMetRules,
    });
    assert.equal(resApproveMet.review.ok, true);
    assert.equal(resApproveMet.ok, true);

    // either mode met with approving
    const resEitherMet1 = evaluate({
      gates: { ...committedGates, pullRequestReview: 'either' },
      rules: approveMetRules,
    });
    assert.equal(resEitherMet1.review.ok, true);

    // either mode met with code-owner
    const resEitherMet2 = evaluate({
      gates: { ...committedGates, pullRequestReview: 'either' },
      rules: ownerMetRules,
    });
    assert.equal(resEitherMet2.review.ok, true);

    // either mode unmet
    const resEitherUnmet = evaluate({
      gates: { ...committedGates, pullRequestReview: 'either' },
      rules: fullRulesPayload,
    });
    assert.equal(resEitherUnmet.review.ok, false);
  });
});

describe('defaultRunGh', () => {
  it('AC7: calls gh with exactly the args given and timeout: 30000, returns ok: true on status 0', () => {
    let captured = null;
    const fakeSpawn = (cmd, args, opts) => {
      captured = { cmd, args, opts };
      return { status: 0, stdout: '[]', stderr: '', error: null };
    };
    const res = defaultRunGh(['api', 'repos/owner/repo/rules/branches/main?per_page=100'], {
      spawn: fakeSpawn,
    });
    assert.equal(res.ok, true);
    assert.equal(captured.cmd, 'gh');
    assert.deepEqual(captured.args, [
      'api',
      'repos/owner/repo/rules/branches/main?per_page=100',
    ]);
    assert.equal(captured.opts.timeout, 30000);
    assert.equal(captured.opts.encoding, 'utf8');
  });

  it('AC7: maps spawn error to ok: false', () => {
    const fakeSpawn = () => ({
      status: null,
      error: new Error('ENOENT'),
      stdout: '',
      stderr: '',
    });
    const res = defaultRunGh(['api', 'test'], { spawn: fakeSpawn });
    assert.equal(res.ok, false);
    assert.match(res.reason, /ENOENT/);
  });

  it('AC7: maps signal to ok: false with signal reason', () => {
    const fakeSpawn = () => ({
      status: 0,
      signal: 'SIGTERM',
      error: null,
      stdout: '',
      stderr: '',
    });
    const res = defaultRunGh(['api', 'test'], { spawn: fakeSpawn });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'gh process terminated by signal SIGTERM');
  });

  it('AC7: maps null status to ok: false with timeout reason', () => {
    const fakeSpawn = () => ({
      status: null,
      signal: null,
      error: null,
      stdout: '',
      stderr: '',
    });
    const res = defaultRunGh(['api', 'test'], { spawn: fakeSpawn });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'gh process terminated by signal timeout');
  });

  it('AC7: maps non-zero status with stderr to ok: false', () => {
    const fakeSpawn = () => ({
      status: 1,
      error: null,
      stdout: '',
      stderr: 'HTTP 404',
    });
    const res = defaultRunGh(['api', 'test'], { spawn: fakeSpawn });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'gh exited with status 1: HTTP 404');
  });

  it('AC7: maps non-zero status with stdout to ok: false', () => {
    const fakeSpawn = () => ({
      status: 1,
      error: null,
      stdout: 'rate limit',
      stderr: '',
    });
    const res = defaultRunGh(['api', 'test'], { spawn: fakeSpawn });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'gh exited with status 1: rate limit');
  });

  it('defaultRunGh with default spawn runs gh --version', () => {
    const res = defaultRunGh(['--version']);
    assert.equal(res.ok, true);
    assert.match(res.stdout, /gh version/);
  });
});

describe('main() execution and CLI', () => {
  it('main handles --contexts with default options', () => {
    const code = main(['--contexts']);
    assert.equal(code, 0);
  });
  function createIo() {
    const stdout = [];
    const stderr = [];
    return {
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
      getStdout: () => stdout.join(''),
      getStderr: () => stderr.join(''),
    };
  }

  it('AC1: returns 2 and stderr names rails-guard, mutation-gate, gate with today live payload', () => {
    const io = createIo();
    const runGh = (args) => {
      return { ok: true, stdout: JSON.stringify(liveRulesPayload) };
    };
    const code = main([], {
      runGh,
      readGates: () => committedGates,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 2);
    const err = io.getStderr();
    assert.match(err, /rails-guard/);
    assert.match(err, /mutation-gate/);
    assert.match(err, /gate/);
    assert.match(err, /docs\/ci\/required-gates\.md/);
  });

  it('AC2: fails closed (exit 1) for unverifiable inputs and nothing on stdout under --json', () => {
    const cases = [
      { name: 'gh error', runGh: () => ({ ok: false, reason: 'failed' }) },
      { name: 'empty stdout', runGh: () => ({ ok: true, stdout: '' }) },
      { name: 'non-JSON stdout', runGh: () => ({ ok: true, stdout: 'not json' }) },
      { name: 'non-array stdout', runGh: () => ({ ok: true, stdout: '{}' }) },
      {
        name: 'required_status_checks not array',
        runGh: () => ({
          ok: true,
          stdout: JSON.stringify([
            { type: 'required_status_checks', parameters: { required_status_checks: 'bad' } },
          ]),
        }),
      },
      {
        name: 'invalid gates doc',
        runGh: () => ({ ok: true, stdout: JSON.stringify([]) }),
        readGates: () => ({ ...committedGates, pullRequestReview: 'bad' }),
      },
    ];

    for (const c of cases) {
      const io = createIo();
      const code = main(['--json'], {
        runGh: c.runGh,
        readGates: c.readGates || (() => committedGates),
        stdout: io.stdout,
        stderr: io.stderr,
      });
      assert.equal(code, 1, `case ${c.name} should exit 1`);
      assert.equal(io.getStdout(), '', `case ${c.name} should output nothing on stdout under --json`);
      assert.match(io.getStderr(), /gate-liveness: cannot verify the ruleset/);
    }
  });

  it('AC2: fails closed (exit 1) for invalid --repo or --branch or unknown flag', () => {
    const invalidArgs = [
      ['--repo', 'invalid-repo-format'],
      ['--branch', 'invalid;branch'],
      ['--unknown-flag'],
      ['--pull-request', 'invalid-mode'],
    ];

    for (const args of invalidArgs) {
      const io = createIo();
      const code = main(args, {
        runGh: () => ({ ok: true, stdout: JSON.stringify([]) }),
        readGates: () => committedGates,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      assert.equal(code, 1, `args ${args.join(' ')} should exit 1`);
      assert.match(io.getStderr(), /gate-liveness:/);
    }
  });

  it('AC3: exit 0 when live set equals declared set', () => {
    const io = createIo();
    const code = main([], {
      runGh: () => ({ ok: true, stdout: JSON.stringify(fullRulesPayload) }),
      readGates: () => committedGates,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 0);
  });

  it('AC3: exit 2 when undeclared context is required in ruleset', () => {
    const io = createIo();
    const extra = [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            ...fullRulesPayload[0].parameters.required_status_checks,
            { context: 'undeclared-check' },
          ],
        },
      },
      fullRulesPayload[1],
    ];
    const code = main([], {
      runGh: () => ({ ok: true, stdout: JSON.stringify(extra) }),
      readGates: () => committedGates,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 2);
    assert.match(io.getStderr(), /undeclared-check/);
  });

  it('AC3: empty rules array is exit 2', () => {
    const io = createIo();
    const code = main([], {
      runGh: () => ({ ok: true, stdout: JSON.stringify([]) }),
      readGates: () => committedGates,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 2);
    assert.match(io.getStderr(), /test \(18\)/);
  });

  it('AC4: prints note when pull-request review is none', () => {
    const io = createIo();
    const code = main([], {
      runGh: () => ({ ok: true, stdout: JSON.stringify(fullRulesPayload) }),
      readGates: () => committedGates,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 0);
    const combined = io.getStdout() + io.getStderr();
    assert.match(combined, /gate-liveness: note - pull-request approval is declared "none"; not asserted/);
  });

  it('AC4: exit 2 when pull-request review mode is unmet', () => {
    const io = createIo();
    const code = main(['--pull-request', 'code-owner'], {
      runGh: () => ({ ok: true, stdout: JSON.stringify(fullRulesPayload) }),
      readGates: () => committedGates,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 2);
    assert.match(io.getStderr(), /code-owner/);
  });

  it('AC7: runGh receives api as first argument, repos/.../rules/branches/... path, and no write flags', () => {
    let capturedArgs = null;
    const runGh = (args) => {
      capturedArgs = args;
      return { ok: true, stdout: JSON.stringify(fullRulesPayload) };
    };
    main(['--repo', 'test-owner/test-repo', '--branch', 'custom-branch'], {
      runGh,
      readGates: () => committedGates,
      stdout: () => {},
      stderr: () => {},
    });
    assert.ok(capturedArgs);
    assert.equal(capturedArgs[0], 'api');
    assert.equal(
      capturedArgs[1],
      'repos/test-owner/test-repo/rules/branches/custom-branch?per_page=100',
    );
    for (const forbidden of ['-X', '--method', '-f', '-F', '--input']) {
      assert.ok(!capturedArgs.includes(forbidden), `must not contain ${forbidden}`);
    }
  });

  it('--json flag outputs structured verdict on exit 0 and 2', () => {
    const io0 = createIo();
    const code0 = main(['--json'], {
      runGh: () => ({ ok: true, stdout: JSON.stringify(fullRulesPayload) }),
      readGates: () => committedGates,
      stdout: io0.stdout,
      stderr: io0.stderr,
    });
    assert.equal(code0, 0);
    const parsed0 = JSON.parse(io0.getStdout());
    assert.equal(parsed0.ok, true);
    assert.deepEqual(parsed0.declared, declaredContexts(committedGates));
    assert.deepEqual(parsed0.missing, []);

    const io2 = createIo();
    const code2 = main(['--json'], {
      runGh: () => ({ ok: true, stdout: JSON.stringify(liveRulesPayload) }),
      readGates: () => committedGates,
      stdout: io2.stdout,
      stderr: io2.stderr,
    });
    assert.equal(code2, 2);
    const parsed2 = JSON.parse(io2.getStdout());
    assert.equal(parsed2.ok, false);
    assert.deepEqual(parsed2.missing, ['rails-guard', 'mutation-gate', 'gate']);
  });
});

describe('AC5: Bijectivity of workflow jobs and declared gates', () => {
  it('workflows with PR triggers equal declared workflows and job ids match', () => {
    const workflowsDir = join(REPO, '.github', 'workflows');
    const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

    const prWorkflows = new Set();
    for (const f of files) {
      const content = readFileSync(join(workflowsDir, f), 'utf8');
      const lines = content.split('\n');
      let inOn = false;
      let hasPrTrigger = false;
      for (const line of lines) {
        if (/^on:\s*$/.test(line)) {
          inOn = true;
          continue;
        }
        if (/^on:\s*(.*)$/.test(line)) {
          const rest = line.replace(/^on:\s*/, '');
          if (/(pull_request|pull_request_target)/.test(rest)) {
            hasPrTrigger = true;
            break;
          }
        }
        if (inOn) {
          if (/^[a-zA-Z0-9_-]+:/.test(line) && !/^  /.test(line)) {
            inOn = false;
          } else if (/^  (pull_request|pull_request_target)(:|\s|,|\]|\}|$)/.test(line)) {
            hasPrTrigger = true;
            break;
          }
        }
      }
      if (hasPrTrigger) {
        prWorkflows.add(`.github/workflows/${f}`);
      }
    }

    const declaredWorkflows = new Set(Object.keys(committedGates.workflows));
    for (const pw of prWorkflows) {
      assert.ok(declaredWorkflows.has(pw), `PR workflow ${pw} must be declared in required-gates.json`);
    }
    for (const dw of declaredWorkflows) {
      assert.ok(prWorkflows.has(dw), `Declared workflow ${dw} must have PR trigger in YAML`);
    }

    // Check each declared workflow's job IDs
    for (const wfPath of declaredWorkflows) {
      const fullPath = join(REPO, wfPath);
      const content = readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      let inJobs = false;
      const yamlJobs = {};
      let currentJob = null;
      let currentJobLines = [];

      for (const line of lines) {
        if (/^jobs:\s*$/.test(line)) {
          inJobs = true;
          continue;
        }
        if (inJobs) {
          if (/^[a-zA-Z0-9_-]+:/.test(line) && !/^  /.test(line)) {
            if (currentJob) yamlJobs[currentJob] = currentJobLines;
            inJobs = false;
            break;
          }
          const jobMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
          if (jobMatch && !line.startsWith('  #')) {
            if (currentJob) yamlJobs[currentJob] = currentJobLines;
            currentJob = jobMatch[1];
            currentJobLines = [];
          } else if (currentJob) {
            currentJobLines.push(line);
          }
        }
      }
      if (currentJob) yamlJobs[currentJob] = currentJobLines;

      const declaredJobs = committedGates.workflows[wfPath];
      const yamlJobIds = Object.keys(yamlJobs);
      const declaredJobIds = Object.keys(declaredJobs);

      for (const yj of yamlJobIds) {
        assert.ok(
          declaredJobs[yj],
          `Job ${yj} in ${wfPath} must be declared in required-gates.json`,
        );
      }
      for (const dj of declaredJobIds) {
        assert.ok(
          yamlJobs[dj],
          `Declared job ${dj} in ${wfPath} must exist in YAML`,
        );
      }

      // Check context structure for blocking jobs
      for (const [jobId, jobDef] of Object.entries(declaredJobs)) {
        if (!jobDef.blocking) continue;
        const jobLines = yamlJobs[jobId] || [];

        // Check if job has a job-level name:
        const hasJobLevelName = jobLines.some((l) => /^    name:\s*/.test(l));
        assert.equal(
          hasJobLevelName,
          false,
          `Blocking job ${jobId} in ${wfPath} must not have a job-level name:`,
        );

        // Check matrix
        const matrixLineIdx = jobLines.findIndex((l) => /^    matrix:\s*$/.test(l) || /^      matrix:\s*$/.test(l));
        if (matrixLineIdx === -1) {
          // non-matrix blocking job declares [<job id>]
          assert.deepEqual(
            jobDef.contexts,
            [jobId],
            `Non-matrix blocking job ${jobId} must declare exactly [${jobId}]`,
          );
        } else {
          // Check single flow-sequence matrix axis
          const matrixLines = jobLines.slice(matrixLineIdx + 1);
          const axisMatches = [];
          for (const ml of matrixLines) {
            if (/^    [a-zA-Z0-9_-]+:/.test(ml) && !/^      /.test(ml)) break;
            const axisMatch = ml.match(/^\s+([a-zA-Z0-9_-]+):\s*\[(.*)\]\s*$/);
            if (axisMatch) {
              axisMatches.push(axisMatch);
            }
          }
          assert.equal(
            axisMatches.length,
            1,
            `Blocking matrix job ${jobId} must have exactly one flow-sequence axis`,
          );
          const values = axisMatches[0][2]
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
          const expectedContexts = values.map((v) => `${jobId} (${v})`);
          assert.deepEqual(
            jobDef.contexts,
            expectedContexts,
            `Matrix blocking job ${jobId} must declare contexts matching its axis`,
          );
        }
      }
    }
  });
});

describe('AC6: CLI spawn checks', () => {
  it('--contexts prints exactly the 6 contexts and exits 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--contexts'], {
      encoding: 'utf8',
      timeout: 10000,
      cwd: REPO,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      JSON.stringify([
        'test (18)',
        'test (20)',
        'test (22)',
        'rails-guard',
        'mutation-gate',
        'gate',
      ]),
    );
  });

  it('--help prints usage and exits 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], {
      encoding: 'utf8',
      timeout: 10000,
      cwd: REPO,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Usage: gate-liveness \[options\]/);
    assert.match(r.stdout, /--repo <owner\/name>\s+Repository in owner\/name format \(default: \{owner\}\/\{repo\}\)/);
    assert.match(r.stdout, /--branch <name>\s+Branch name \(default from required-gates\.json\)/);
    assert.match(r.stdout, /--pull-request <mode>\s+Override pullRequestReview mode \(none\|code-owner\|approving\|either\)/);
    assert.match(r.stdout, /--json\s+Output JSON verdict on stdout for exit 0 and 2/);
    assert.match(r.stdout, /--contexts\s+Print declared blocking contexts as JSON array and exit 0/);
    assert.match(r.stdout, /-h, --help\s+Show this help message and exit/);
  });
});

describe('AC8: Consumer agreement with autopilot ci.mjs', () => {
  it('every declared blocking context is classified blocking by blockingPrefixOf', () => {
    const contexts = declaredContexts(committedGates);
    const crossModelWorkflowName = 'cross-model-gate'; // from cross-model-gate.yml name: cross-model-gate
    for (const ctx of contexts) {
      const row = ctx === 'gate' ? { name: ctx, workflow: crossModelWorkflowName } : { name: ctx };
      const prefix = blockingPrefixOf(row);
      assert.ok(
        prefix !== null,
        `Context ${ctx} must be recognized as blocking by blockingPrefixOf`,
      );
    }
  });
});

describe('AC9: Workflow wiring of gate-liveness.yml', () => {
  it('gate-liveness.yml has the three triggers, no PR trigger, runs script, no continue-on-error', () => {
    const ymlPath = join(REPO, '.github', 'workflows', 'gate-liveness.yml');
    const content = readFileSync(ymlPath, 'utf8');

    assert.match(content, /^on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/m);
    assert.match(content, /schedule:\s*\n\s*-\s*cron:/);
    assert.match(content, /workflow_dispatch:/);
    assert.doesNotMatch(content, /pull_request/);
    assert.match(content, /node scripts\/gate-liveness\.mjs/);
    assert.doesNotMatch(content, /continue-on-error:\s*true/);
  });

  it('gate-liveness.mjs imports only node: specifiers', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf8');
    const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
    for (const match of importMatches) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:'),
        `Specifier ${specifier} must start with 'node:'`,
      );
    }
  });
});

describe('AC13: Committed ruleset agreement', () => {
  it('main-branch-ruleset.json agrees with required-gates.json and has integration_id 15368', () => {
    const res = evaluate({ gates: committedGates, rules: committedRuleset.rules });
    assert.equal(res.ok, true);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.undeclared, []);

    const rule = committedRuleset.rules.find((r) => r.type === 'required_status_checks');
    assert.ok(rule, 'must have required_status_checks rule');
    const checks = rule.parameters.required_status_checks;
    assert.equal(checks.length, 6);
    for (const c of checks) {
      assert.equal(c.integration_id, 15368, `Context ${c.context} must have integration_id 15368`);
    }
  });
});
