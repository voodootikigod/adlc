// cli-help.test.mjs — parseArgs must answer --help for configs that pass no
// `usage` (issue #107: seven shipped bins crashed with a raw
// ERR_PARSE_ARGS_UNKNOWN_OPTION stack trace on the first command a new
// consumer runs). Configs that DO pass `usage` must be untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../lib/cli.mjs';

const CORE_INDEX = fileURLToPath(new URL('../index.mjs', import.meta.url));

// The real packages/preflight config, one of the seven crashers.
const PREFLIGHT_OPTIONS = {
  'test-cmd': { type: 'string' },
  gh: { type: 'boolean', default: false },
  llm: { type: 'boolean', default: false },
  worktrees: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

// What a `preflight --help` user actually sees, to the byte. Asserted whole
// rather than probed line by line: a listing whose columns drift is a listing
// nobody proofread.
const PREFLIGHT_LISTING = [
  'usage: preflight [options]',
  '',
  'options:',
  '  --test-cmd <value>',
  '  --gh                (default: false)',
  '  --llm               (default: false)',
  '  --worktrees         (default: false)',
  '  --json              (default: false)',
  '  -h, --help          show this help',
  '',
].join('\n');

/**
 * Run parseArgs with process.exit and console.log stubbed. Returns what was
 * logged, the exit code, and whether parseArgs exited at all. Parse errors
 * propagate to the caller (with the stubs restored) so they stay assertable.
 *
 * Nothing here asserts the program name: in-process, that name comes from
 * whatever the test runner put in process.argv[1]. Program-name and exit-code
 * claims are made through runBin() instead, against an argv[1] this file chose.
 */
function capture(config) {
  const originalExit = process.exit;
  const originalLog = console.log;
  const logs = [];
  let exitCode;
  let exited = false;
  process.exit = (code) => {
    exitCode = code;
    exited = true;
    throw new Error('__exited__');
  };
  console.log = (msg) => logs.push(msg);
  let returned;
  try {
    returned = parseArgs(config);
  } catch (err) {
    if (!exited) throw err;
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
  }
  return { exited, exitCode, logs, output: logs.join('\n'), returned };
}

/**
 * Write a real bin named `<name>.mjs` that calls parseArgs with `config`, run it
 * with `argv`, and hand back the process result. `REACHED_BODY` on stdout means
 * parseArgs returned instead of printing help and exiting.
 */
function runBin(name, config, argv) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-help-'));
  try {
    const bin = join(dir, `${name}.mjs`);
    writeFileSync(
      bin,
      `import { parseArgs } from ${JSON.stringify(CORE_INDEX)};\n` +
        `parseArgs(${JSON.stringify(config)});\n` +
        `console.log('REACHED_BODY');\n`
    );
    return spawnSync(process.execPath, [bin, ...argv], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── usage-less configs: the bug ──────────────────────────────────────────────

test('--help on a usage-less config prints the flag listing and exits 0', () => {
  const run = runBin('preflight', { options: PREFLIGHT_OPTIONS }, ['--help']);

  assert.equal(run.status, 0);
  assert.equal(run.stderr, '', 'no stack trace, no warning');
  assert.equal(run.stdout, PREFLIGHT_LISTING);
});

test('-h prints the same listing and exits 0', () => {
  const run = runBin('preflight', { options: PREFLIGHT_OPTIONS }, ['-h']);

  assert.equal(run.status, 0);
  assert.equal(run.stdout, PREFLIGHT_LISTING);
});

test('the listing names the program being run, not a fixed string', () => {
  const one = runBin('skill-rot', { options: { json: { type: 'boolean' } } }, ['--help']);
  const two = runBin('model-router', { options: { json: { type: 'boolean' } } }, ['--help']);

  assert.match(one.stdout, /^usage: skill-rot \[options\]\n/);
  assert.match(two.stdout, /^usage: model-router \[options\]\n/);
});

test('a program with no argv[1] at all falls back to the suite name', () => {
  // `node -e` leaves process.argv[1] undefined — the one case the fallback is
  // for. Without it the listing would open with "usage: undefined".
  const run = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(CORE_INDEX)}).then((m) => m.parseArgs({ args: ['--help'], options: {} }));`],
    { encoding: 'utf8' }
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /^usage: adlc \[options\]\n/);
});

test('a bin whose filename is only an extension still gets a name', () => {
  // argv[1] is set rather than a file named `.mjs` written and run: Node 18
  // cannot load such a file at all, and the branch under test is the name
  // derivation, not the loader. Stripping the extension leaves nothing, and a
  // listing headed "usage:  [options]" names no command the reader can run.
  const run = spawnSync(
    process.execPath,
    ['-e',
      `process.argv[1] = '/opt/tools/.mjs';\n` +
      `import(${JSON.stringify(CORE_INDEX)}).then((m) => m.parseArgs({ args: ['--help'], options: {} }));`],
    { encoding: 'utf8' }
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /^usage: adlc \[options\]\n/);
});

test('--help is honored anywhere in argv, not just first', () => {
  const { exited, exitCode, output } = capture({
    args: ['capture', '--json', '--help'],
    options: PREFLIGHT_OPTIONS,
  });
  assert.equal(exited, true);
  assert.equal(exitCode, 0);
  assert.match(output, /^usage: /);
});

test('the listing renders short aliases, string values and defaults', () => {
  const run = runBin('demo', {
    options: {
      request: { type: 'string', short: 'r' },
      tier: { type: 'string', default: 'mid' },
      file: { type: 'string', multiple: true },
      write: { type: 'boolean', default: false },
      bare: { type: 'boolean' },
    },
  }, ['--help']);

  // Columns are set by the longest label, and a flag with no default — like
  // --bare — carries no annotation at all.
  assert.equal(run.stdout, [
    'usage: demo [options]',
    '',
    'options:',
    '  -r, --request <value>',
    '  --tier <value>         (default: mid)',
    '  --file <value...>',
    '  --write                (default: false)',
    '  --bare',
    '  -h, --help             show this help',
    '',
  ].join('\n'));
});

test('a config with no options at all still answers --help instead of crashing', () => {
  const run = runBin('empty-tool', {}, ['--help']);

  assert.equal(run.status, 0);
  assert.equal(run.stdout, ['usage: empty-tool [options]', '', 'options:', '  -h, --help  show this help', ''].join('\n'));
});

// ── the paths that must NOT change ───────────────────────────────────────────

test('a configured string usage still wins over synthesis, byte for byte', () => {
  const { exited, exitCode, logs } = capture({
    args: ['--help'],
    usage: 'my custom usage text',
    options: PREFLIGHT_OPTIONS,
  });

  assert.equal(exited, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(logs, ['my custom usage text'], 'no synthesized listing is appended');
});

test('a configured usage callback still wins over synthesis', () => {
  let called = 0;
  const { exited, exitCode, logs } = capture({
    args: ['-h'],
    usage: () => { called += 1; },
    options: PREFLIGHT_OPTIONS,
  });

  assert.equal(exited, true);
  assert.equal(exitCode, 0);
  assert.equal(called, 1);
  assert.deepEqual(logs, [], 'the callback owns all output');
});

test('a config that declares help itself is still not intercepted', () => {
  const { exited, returned } = capture({
    args: ['--help'],
    options: { help: { type: 'boolean' } },
  });
  assert.equal(exited, false);
  assert.equal(returned.values.help, true);
});

test('a config that declares an option literally named h is still not intercepted', () => {
  const { exited, returned } = capture({
    args: ['-h'],
    options: { h: { type: 'boolean' } },
  });
  assert.equal(exited, false);
  assert.equal(returned.values.h, true);
});

test('unknown flags other than help still fail loudly', () => {
  assert.throws(
    () => capture({ args: ['--nope'], options: PREFLIGHT_OPTIONS }),
    (err) => err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
  );

  // And at process level, where the tool body must never run.
  const run = runBin('preflight', { options: PREFLIGHT_OPTIONS }, ['--nope']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
  assert.doesNotMatch(run.stdout, /REACHED_BODY/);
});

test('a usage-less config parses normally when no help flag is present', () => {
  const { exited, returned } = capture({
    args: ['capture', '--json', '--test-cmd', 'npm test'],
    options: PREFLIGHT_OPTIONS,
  });
  assert.equal(exited, false);
  assert.equal(returned.values.json, true);
  assert.equal(returned.values['test-cmd'], 'npm test');
  assert.deepEqual(returned.positionals, ['capture']);

  // The tool body is reached at process level too — help must not swallow a
  // normal run.
  const run = runBin('preflight', { options: PREFLIGHT_OPTIONS }, ['--json']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /REACHED_BODY/);
});
