import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, ADAPTERS, adapterCatalog } from '../lib/adapters/index.mjs';

const PROMPT = 'build ticket T1 as specified';
const ENV = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ANTHROPIC_API_KEY: 'sk' };

// Each entry: adapter name → expected default { cmd, args } and whether it pipes
// the prompt on stdin (agy).
const EXPECTED = {
  codex: { cmd: 'codex', args: ['exec', PROMPT], stdin: false },
  gemini: { cmd: null, args: ['--print'], stdin: true },
  agy: { cmd: 'agy', args: ['--print'], stdin: true },
  jetski: { cmd: 'jetski', args: ['--print'], stdin: true },
  // `--format json` is load-bearing, not cosmetic: it is the only mode that
  // emits the step_finish token events T152's usage parser reads. Dropping it
  // silently downgrades every opencode dispatch to usageStatus 'unreported'.
  opencode: { cmd: 'opencode', args: ['run', '--format', 'json', PROMPT], stdin: false },
  pi: { cmd: 'pi', args: ['run', PROMPT], stdin: false },
  cursor: { cmd: 'cursor-agent', args: ['-p', PROMPT], stdin: false },
  copilot: { cmd: 'copilot', args: ['-p', PROMPT, '--allow-tool', 'write', '--allow-tool', 'shell'], stdin: false },
};

function stubExec(rec, result = { status: 0, stdout: 'ok', stderr: '' }) {
  return (cmd, args, opts) => { rec.push({ cmd, args, opts }); return result; };
}

for (const [adapterName, exp] of Object.entries(EXPECTED)) {
  test(`${adapterName}: dispatch spawns the harness headless with the prompt + model-plane env (AC2)`, async () => {
    const rec = [];
    const r = await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 60000, env: ENV, exec: stubExec(rec),
    });
    assert.equal(rec.length, 1);
    if (exp.cmd === null) {
      assert.ok(rec[0].cmd.endsWith('agy') || rec[0].cmd.endsWith('jetski'), `${adapterName}: command must end with agy or jetski, got "${rec[0].cmd}"`);
    } else {
      assert.ok(rec[0].cmd === exp.cmd || rec[0].cmd.endsWith(`/${exp.cmd}`) || rec[0].cmd.endsWith(`\\${exp.cmd}`), `${adapterName}: command must match or end with "${exp.cmd}", got "${rec[0].cmd}"`);
    }
    assert.deepEqual(rec[0].args, exp.args, `${adapterName}: default args`);
    assert.equal(rec[0].opts.cwd, '/wt/T1', `${adapterName}: cwd is the worktree`);
    assert.equal(rec[0].opts.env, ENV, `${adapterName}: env passed through (model plane)`);
    assert.equal(rec[0].opts.timeout, 60000);
    if (exp.stdin) assert.equal(rec[0].opts.input, PROMPT, `${adapterName}: prompt piped on stdin`);
    else assert.equal(rec[0].opts.input, undefined, `${adapterName}: does NOT pipe stdin by default`);
    assert.equal(r.exitCode, 0);
  });

  test(`${adapterName}: a non-zero exit maps to a failed-strike result`, async () => {
    const rec = [];
    const r = await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 60000, env: ENV,
      exec: stubExec(rec, { status: 3, stderr: 'boom' }),
    });
    assert.equal(r.exitCode, 3);
    assert.match(r.output, /boom/);
  });

  test(`${adapterName}: a timeout maps to timedOut with a non-zero exit`, async () => {
    const rec = [];
    const r = await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 10, env: ENV,
      exec: stubExec(rec, { status: null, signal: 'SIGTERM', timedOut: true }),
    });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.exitCode, 0);
  });

  test(`${adapterName}: config command/args override the default (AC3 — CLI change is a config fix)`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 60000, env: ENV, exec: stubExec(rec),
      command: 'my-harness', args: ['--custom', 'flag'],
    });
    assert.equal(rec[0].cmd, 'my-harness', `${adapterName}: command overridden`);
    assert.deepEqual(rec[0].args, ['--custom', 'flag'], `${adapterName}: args overridden`);
  });
}

test('pi: useStdin pipes the prompt on stdin (A3 RPC transport)', async () => {
  const rec = [];
  await getAdapter('pi').dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), args: ['--mode', 'rpc'], useStdin: true });
  assert.deepEqual(rec[0].args, ['--mode', 'rpc']);
  assert.equal(rec[0].opts.input, PROMPT, 'prompt routed to stdin when useStdin');
});

test('agy: --model is added from the model option', async () => {
  const rec = [];
  await getAdapter('agy').dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), model: 'Claude Opus 4.6' });
  assert.deepEqual(rec[0].args, ['--print', '--model', 'Claude Opus 4.6']);
});

// ---- operating-stack §4c: FORCE the concrete model onto the command line ----
//
// The registry's model is worthless if the adapter drops it: the harness would
// quietly run its ambient default while every usage record and attestation
// claimed the registry's model. Each expectation below is the argv the installed
// CLI actually accepts (`opencode run --help`, `codex exec --help`,
// `claude --help` all document -m/--model).

const FORCED = {
  'claude-code': {
    model: 'claude-opus-5',
    // `--output-format json` (not text) for the same reason opencode gets
    // `--format json`: it is the mode that carries the usage block.
    args: ['-p', PROMPT, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--model', 'claude-opus-5'],
  },
  codex: { model: 'gpt-5.3-codex', args: ['exec', '-m', 'gpt-5.3-codex', PROMPT] },
  opencode: { model: 'zai/glm-5.2', args: ['run', '--format', 'json', '-m', 'zai/glm-5.2', PROMPT] },
};

for (const [adapterName, exp] of Object.entries(FORCED)) {
  test(`${adapterName}: the registry model is forced explicitly into argv (§4c)`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), model: exp.model,
    });
    assert.deepEqual(rec[0].args, exp.args);
  });

  test(`${adapterName}: the "default" sentinel is NOT put on the command line`, async () => {
    const rec = [];
    await getAdapter(adapterName).dispatch({
      worktree: '/wt/T1', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), model: 'default',
    });
    assert.ok(!rec[0].args.includes('default'), `${adapterName} must let the harness resolve its own default`);
    assert.ok(!rec[0].args.includes('-m') && !rec[0].args.includes('--model'), `${adapterName}: no model flag`);
  });
}

// ---- operating-stack §4b rule 6: the alias contract is ADAPTER-owned ----

test('every adapter declares its run-time alias set, including the default sentinel', () => {
  for (const adapterName of ADAPTERS) {
    const declared = getAdapter(adapterName).aliases;
    assert.ok(Array.isArray(declared), `${adapterName} must export an aliases array`);
    assert.ok(declared.includes('default'), `${adapterName} must declare the 'default' sentinel`);
    for (const alias of declared) assert.equal(typeof alias, 'string');
  }
});

test('adapterCatalog covers exactly the registered adapters and mirrors their aliases', () => {
  const catalog = adapterCatalog();
  assert.deepEqual(Object.keys(catalog).sort(), [...ADAPTERS].sort());
  for (const adapterName of ADAPTERS) {
    assert.deepEqual(catalog[adapterName].aliases, [...getAdapter(adapterName).aliases]);
  }
});

// ---- §4c: an adapter must not claim a model-forcing it cannot deliver ----

test('every adapter declares whether it can force an explicit model', () => {
  for (const adapterName of ADAPTERS) {
    assert.equal(typeof getAdapter(adapterName).forcesModel, 'boolean', `${adapterName}.forcesModel`);
  }
});

test('a declared forcesModel is PROVEN by the argv the adapter renders', async () => {
  // The declaration is what registry validation trusts, so it cannot be a
  // comment: an adapter claiming to force must actually put the model on the
  // command line, and one claiming it cannot must leave argv unchanged.
  for (const adapterName of ADAPTERS) {
    const adapter = getAdapter(adapterName);
    const withModel = [];
    const without = [];
    await adapter.dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(withModel), model: 'probe/model-x' });
    await adapter.dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(without) });

    const carried = withModel[0].args.includes('probe/model-x');
    assert.equal(
      carried,
      adapter.forcesModel,
      `${adapterName}: declares forcesModel=${adapter.forcesModel} but ${carried ? 'DID' : 'did NOT'} put the model in argv`
    );
    if (!adapter.forcesModel) {
      assert.deepEqual(withModel[0].args, without[0].args, `${adapterName}: a model must not alter argv it cannot carry`);
    }
  }
});

test('agy: the default sentinel is not emitted as a literal --model default', async () => {
  const rec = [];
  await getAdapter('agy').dispatch({ worktree: '/wt', prompt: PROMPT, timeoutMs: 1, env: ENV, exec: stubExec(rec), model: 'default' });
  assert.deepEqual(rec[0].args, ['--print'], 'agy must let its harness resolve the default, not name a model called "default"');
});

// The alias set is a claim about an EXTERNAL CLI, so it cannot be derived from
// anything in this repo — which means a test that reads `adapter.aliases` to
// build its own fixtures cannot notice the list shrinking. It shrinks with the
// fixtures and every generated case still passes.
//
// This asserts the set independently. It is not a source-text pin: dropping an
// entry has observable consequences — that alias stops being rejected for a
// reviewer seat and starts passing as a concrete model ID, which is precisely
// the reviewer-identity drift §4b rule 6 exists to prevent. Adding aliases is
// fine (a superset only rejects more), removing one is the regression.
test('claude-code declares at least the aliases its harness documents', () => {
  // Grounded in `claude --help`: "--model … Provide an alias for the latest
  // model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name", plus the
  // registry's own `default` sentinel and the remaining documented aliases.
  const documented = ['default', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan'];
  const declared = new Set(getAdapter('claude-code').aliases);
  const missing = documented.filter((a) => !declared.has(a));
  assert.deepEqual(missing, [], `claude-code dropped documented alias(es): ${missing.join(', ')}`);
});
