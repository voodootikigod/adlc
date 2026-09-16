// limit-flag.test.mjs — `--limit <n>`, the flag the truncation error points at.
//
// The provider fails closed when a fetch reaches its cap and tells the operator to
// "raise --limit". Until this flag existed that advice produced `unknown flag:
// --limit`, exit 1, so a selection of 500+ issues could not sync at all. These
// tests pin the validator, the parser, and — through the real binary — that the
// value actually reaches `gh`'s argv for every subcommand that lists issues.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLimit } from '../lib/limit.mjs';
import { parseFlags } from '../bin/ticket-sync.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ticket-sync.mjs');
const MISSING = '--limit requires a positive integer value';
const invalid = (raw) => `invalid --limit: ${raw} (expected a positive integer)`;

const SANDBOXES = [];
after(() => {
  for (const dir of SANDBOXES) rmSync(dir, { recursive: true, force: true });
});

test('parseLimit accepts a positive decimal integer', () => {
  assert.deepEqual(parseLimit('1'), { ok: true, value: 1 });
  assert.deepEqual(parseLimit('1000'), { ok: true, value: 1000 });
  assert.deepEqual(parseLimit('9007199254740991'), { ok: true, value: Number.MAX_SAFE_INTEGER });
});

test('parseLimit rejects anything that is not a positive decimal integer, without coercion', () => {
  for (const raw of ['0', '-1', '1.5', '1.0', '1e3', '0x10', 'abc', '', ' 5', '5 ', '007', '9007199254740993']) {
    assert.deepEqual(parseLimit(raw), { ok: false, error: invalid(raw) }, `must reject ${JSON.stringify(raw)}`);
  }
});

test('parseLimit reports a missing value distinctly from an invalid one', () => {
  assert.deepEqual(parseLimit(undefined), { ok: false, error: MISSING });
  // The next token being another flag means the value was forgotten, not that
  // "--json" is a malformed number.
  assert.deepEqual(parseLimit('--json'), { ok: false, error: MISSING });
});

test('parseLimit refuses a non-string even when it looks numeric', () => {
  // argv is always strings; a number here is a caller bug, and coercing it would
  // make the regex check a check of String(raw) rather than of the input.
  assert.equal(parseLimit(5).ok, false);
  assert.equal(parseLimit(null).ok, false);
});

test('parseFlags consumes the value token and leaves every other flag intact', () => {
  const f = parseFlags(['--write', '--limit', '1000', '--json']);
  assert.equal(f.limit, 1000);
  assert.equal(f.write, true);
  assert.equal(f.json, true, 'the flag after the value is still parsed as a flag');
  assert.equal(parseFlags([]).limit, undefined, 'absent flag leaves the provider default in charge');
  assert.equal(parseFlags(['--limit', '5', '--limit', '7']).limit, 7, 'a repeated --limit takes the last value');
});

/** Run the binary; never throws. */
function runBin(args, { cwd = process.cwd(), env = process.env } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

for (const [label, args, expected] of [
  ['zero', ['pull', '--limit', '0'], invalid('0')],
  ['non-numeric', ['push', '--limit', 'lots'], invalid('lots')],
  ['missing at the end', ['pull', '--limit'], MISSING],
  ['missing before another flag', ['sync', '--limit', '--json'], MISSING],
]) {
  test(`an invalid --limit (${label}) exits 1 with the validator's message and nothing on stdout`, () => {
    const r = runBin(args);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `${expected}\n`);
    assert.equal(r.stdout, '');
  });
}

/** The default `--help` promises, as the number it prints. */
function helpStatedDefault() {
  const r = runBin(['--help']);
  assert.equal(r.status, 0);
  const m = /^--limit <n> caps how many issues pull\/push list from the tracker \(default (\d+)\)\.$/m.exec(r.stdout);
  assert.ok(m, `--help must describe --limit and its default, got:\n${r.stdout}`);
  return m[1];
}

test('--help documents --limit in the usage line and describes it', () => {
  const r = runBin(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[--limit <n>\] \[--json\]/);
  helpStatedDefault();
});

/**
 * A repo whose `gh` is a recording fake.
 *
 * The fake does NOT read stdin. ticket-sync's runner (lib/gh.mjs) uses async
 * execFile, which neither writes to nor closes the child's stdin, so a
 * `cat > /dev/null` drain would block forever on an EOF that never arrives.
 */
function repoWithFakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-limit-'));
  SANDBOXES.push(dir);
  const bin = join(dir, 'fakebin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'repo', '.adlc'), { recursive: true });
  writeFileSync(join(dir, 'repo', '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }));
  const log = join(dir, 'gh.log');
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$1 $2" in',
      `  "api user") echo '{"login":"tester"}' ;;`,
      "  *) echo '[]' ;;",
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.ADLC_MANIFEST_KEY;
  return {
    run: (args) => runBin(args, { cwd: join(dir, 'repo'), env }),
    listCalls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('issue list')) : []),
  };
}

const limitOf = (call) => {
  const tokens = call.split(' ');
  const i = tokens.indexOf('--limit');
  return i >= 0 ? tokens[i + 1] : null;
};

for (const sub of ['pull', 'push']) {
  test(`${sub} --limit 1000 reaches gh's issue list argv`, () => {
    const repo = repoWithFakeGh();
    const r = repo.run([sub, '--limit', '1000']);
    const calls = repo.listCalls();
    assert.equal(calls.length, 1, `expected one issue list call, got ${JSON.stringify(calls)}; stderr: ${r.stderr}`);
    assert.equal(limitOf(calls[0]), '1000');
  });

  test(`${sub} without --limit keeps the provider default, which is the one --help states`, () => {
    const repo = repoWithFakeGh();
    const r = repo.run([sub]);
    const calls = repo.listCalls();
    assert.equal(calls.length, 1, `expected one issue list call, got ${JSON.stringify(calls)}; stderr: ${r.stderr}`);
    assert.equal(limitOf(calls[0]), '500');
    // An operator deciding how far to raise the cap reads the default from --help;
    // a stated default that differs from the real one sends them the wrong way.
    assert.equal(helpStatedDefault(), limitOf(calls[0]));
  });
}

test('sync --limit 1000 applies the limit to both the pull and the push listing', () => {
  const repo = repoWithFakeGh();
  const r = repo.run(['sync', '--limit', '1000']);
  const calls = repo.listCalls();
  assert.equal(calls.length, 2, `expected pull and push to each list issues, got ${JSON.stringify(calls)}; stderr: ${r.stderr}`);
  assert.deepEqual(calls.map(limitOf), ['1000', '1000']);
});
