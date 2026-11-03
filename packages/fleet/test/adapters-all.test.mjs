import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter, ADAPTERS, adapterCatalog } from '../lib/adapters/index.mjs';
import { detectBinary } from '../lib/adapters/gemini.mjs';

const STUB_BIN = mkdtempSync(join(tmpdir(), "fleet-adapters-all-bin-"));
for (const bin of ["agy", "jetski"]) {
  const p = join(STUB_BIN, bin);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
}
after(() => { rmSync(STUB_BIN, { recursive: true, force: true }); });

const PROMPT = 'build ticket T1 as specified';
const ENV = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1', ANTHROPIC_API_KEY: 'sk', PATH: STUB_BIN };

// Each entry: adapter name → expected default { cmd, args } and whether it pipes
// the prompt on stdin (agy).
const EXPECTED = {
  codex: { cmd: 'codex', args: ['exec', PROMPT], stdin: false },
  // agy/jetski `--print` is a flag whose VALUE is the prompt, not a stdin mode
  // (issue #866) — the prompt is an argv value by default.
  gemini: { cmd: null, args: ['--print', PROMPT], stdin: false },
  agy: { cmd: 'agy', args: ['--print', PROMPT], stdin: false },
  jetski: { cmd: 'jetski', args: ['--print', PROMPT], stdin: false },
  // `--format json` is load-bearing, not cosmetic: it is the only mode that
  // emits the step_finish token events T152's usage parser reads. Dropping it
  // silently downgrades every opencode dispatch to usageStatus 'unreported'.
  opencode: { cmd: 'opencode', args: ['run', '--format', 'json', PROMPT], stdin: false },
  // pi has no `run` subcommand; `--print`/`-p` is its documented non-interactive
  // mode (issue #867).
  pi: { cmd: 'pi', args: ['--print', PROMPT], stdin: false },
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
  assert.deepEqual(rec[0].args, ['--print', PROMPT, '--model', 'Claude Opus 4.6']);
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
  assert.deepEqual(rec[0].args, ['--print', PROMPT], 'agy must let its harness resolve the default, not name a model called "default"');
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

// ---- #454 / #455 / #633: gemini aliases, detectBinary PATH hardening, and fail-closed dispatch ----

test('gemini, agy, and jetski declare only the default sentinel in aliases — no CLI binary names (#454)', () => {
  for (const name of ["gemini", "agy", "jetski"]) {
    assert.deepEqual(getAdapter(name).aliases, ["default"], `${name} aliases must not include CLI binary names`);
  }
});

test('detectBinary resolves executable agy and jetski stubs on PATH and dispatch invokes the resolved absolute path (#455)', async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-detect-bin-"));
  try {
    const agyStub = join(dir, "agy");
    writeFileSync(agyStub, "#!/bin/sh\nexit 0\n");
    chmodSync(agyStub, 0o755);
    assert.equal(detectBinary(undefined, { PATH: dir }, "linux"), agyStub);

    const recAgy = [];
    await getAdapter("gemini").dispatch({
      worktree: "/wt", prompt: PROMPT, timeoutMs: 1, env: { PATH: dir }, exec: stubExec(recAgy),
    });
    assert.equal(recAgy[0].cmd, agyStub, "gemini dispatch must execute the resolved agy path");

    // When jetski is also present, default target order ["jetski", "agy"] prefers jetski; explicit agy/jetski adapters resolve their own binary
    const jetskiStub = join(dir, "jetski");
    writeFileSync(jetskiStub, "#!/bin/sh\nexit 0\n");
    chmodSync(jetskiStub, 0o755);
    assert.equal(detectBinary(undefined, { PATH: dir }, "linux"), jetskiStub);
    assert.equal(detectBinary(["agy"], { PATH: dir }, "linux"), agyStub);
    assert.equal(detectBinary(["jetski"], { PATH: dir }, "linux"), jetskiStub);

    const recGem = [];
    await getAdapter("gemini").dispatch({
      worktree: "/wt", prompt: PROMPT, timeoutMs: 1, env: { PATH: dir }, exec: stubExec(recGem),
    });
    assert.equal(recGem[0].cmd, jetskiStub);

    const recExplicitAgy = [];
    await getAdapter("agy").dispatch({
      worktree: "/wt", prompt: PROMPT, timeoutMs: 1, env: { PATH: dir }, exec: stubExec(recExplicitAgy),
    });
    assert.equal(recExplicitAgy[0].cmd, agyStub);

    const recExplicitJetski = [];
    await getAdapter("jetski").dispatch({
      worktree: "/wt", prompt: PROMPT, timeoutMs: 1, env: { PATH: dir }, exec: stubExec(recExplicitJetski),
    });
    assert.equal(recExplicitJetski[0].cmd, jetskiStub);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectBinary supports Windows PATHEXT and semicolon-delimited PATH entries (#455)', () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-detect-win-"));
  try {
    const cmdStub = join(dir, "agy.cmd");
    writeFileSync(cmdStub, "@echo off\r\n");
    chmodSync(cmdStub, 0o755);
    const resolved = detectBinary(["agy"], { PATH: `/nonexistent;${dir}`, PATHEXT: ".EXE;.CMD" }, "win32");
    assert.equal(resolved, cmdStub);
    // Default PATHEXT fallback when PATHEXT is unset
    const savedPathExt = process.env.PATHEXT;
    delete process.env.PATHEXT;
    try {
      assert.equal(detectBinary(["agy"], { PATH: dir }, "win32"), cmdStub);
    } finally {
      if (savedPathExt !== undefined) process.env.PATHEXT = savedPathExt;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectBinary skips relative PATH entries, node_modules/.bin, node-gyp-bin, directories, and non-executable files, and dispatch fails closed (#633)', async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-detect-hardening-"));
  try {
    const nmBin = join(dir, "node_modules", ".bin");
    const gypBin = join(dir, "node-gyp-bin");
    const dirAsBin = join(dir, "dir-entry");
    const nonExecDir = join(dir, "non-exec");
    mkdirSync(nmBin, { recursive: true });
    mkdirSync(gypBin, { recursive: true });
    mkdirSync(join(dirAsBin, "agy"), { recursive: true });
    mkdirSync(nonExecDir, { recursive: true });

    for (const d of [nmBin, gypBin]) {
      const planted = join(d, "agy");
      writeFileSync(planted, "#!/bin/sh\nexit 0\n");
      chmodSync(planted, 0o755);
    }
    const nonExecFile = join(nonExecDir, "agy");
    writeFileSync(nonExecFile, "#!/bin/sh\nexit 0\n");
    chmodSync(nonExecFile, 0o644);

    const hostilePath = ["relative/bin", `${nmBin}/`, gypBin, dirAsBin, nonExecDir].join(":");
    assert.equal(detectBinary(["jetski", "agy"], { PATH: hostilePath }, "linux"), null);

    // Even when a custom exec is injected (as live-deps does in production), gemini/agy/jetski MUST throw rather than falling back to bare "agy" or "jetski" (#633)
    for (const adapterName of ["gemini", "agy", "jetski"]) {
      const rec = [];
      await assert.rejects(
        () => getAdapter(adapterName).dispatch({
          worktree: "/wt", prompt: PROMPT, timeoutMs: 1, env: { PATH: hostilePath }, exec: stubExec(rec),
        }),
        /Google Gemini integration: safe agent binary not found in PATH\./,
      );
      assert.equal(rec.length, 0, `${adapterName} must not invoke exec when detectBinary returns null`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
