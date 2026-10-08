// Configuration errors (AC2): each exits 1 before reading or sending anything,
// and writes no record. Every run here has fetch made fatal (exit 97), so an
// exit of 1 also shows nothing was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';
import { FETCH_EXIT_CODE, NO_NETWORK_PRELOAD, installNoNetwork } from './helpers/no-network.mjs';
import { changeRepo, responseFile, runCli } from './helpers/fixtures.mjs';
import { SHIPPED_PACKS_DIR as PACKS_DIR } from '../lib/pack.mjs';
import { createHash } from 'node:crypto';

installNoNetwork();

const SHADOW = ['evaluate', '--mode', 'shadow', '--provider', 'mock', '--model', 'mock-1', '--pack', 'change-risk-v1'];
const recordFile = (dir) => join(dir, '.adlc', 'decisions', 'runs.jsonl');

function refused(t, args, pattern, { env, prepare } = {}) {
  const { dir } = changeRepo(t);
  prepare?.(dir);
  const result = runCli(t, args, { cwd: dir, env });
  assert.equal(result.status, 1, `${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /^adlc decision: [^\n]*\n$/, `expected exactly one error line, got ${JSON.stringify(result.stderr)}`);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(recordFile(dir)), false, 'a refused run wrote a record');
}

test('the fetch guard is live in spawned processes', (t) => {
  const result = spawnSync(process.execPath, [`--import=${NO_NETWORK_PRELOAD}`, '-e', "fetch('https://example.invalid')"], {
    cwd: tmp(t, 'decision-guard-'),
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, FETCH_EXIT_CODE);
});

for (const mode of ['enforce', 'live', '']) {
  test(`--mode ${JSON.stringify(mode)} is refused`, (t) => {
    refused(t, ['evaluate', '--mode', mode, '--provider', 'mock', '--model', 'm', '--pack', 'change-risk-v1'], /unknown --mode/);
  });
}

test('a provider without --mode shadow is refused, including with --mode off', (t) => {
  refused(t, ['evaluate', '--provider', 'mock', '--model', 'm', '--pack', 'change-risk-v1'], /--provider needs --mode shadow/);
  refused(t, ['evaluate', '--mode', 'off', '--provider', 'mock'], /--provider needs --mode shadow/);
});

test('jev without an API key is refused', (t) => {
  refused(t, [...SHADOW.slice(0, 4), 'jev', ...SHADOW.slice(5)], /needs TYPESAFE_API_KEY or JEV_API_KEY/);
});

for (const [value, pattern] of [
  ['http://api.typesafe.ai/v1/systemone', /TYPESAFE_API_URL must use https/],
  ['https://user:pass@api.typesafe.ai/v1/systemone', /TYPESAFE_API_URL may not carry credentials/],
  ['not a url', /TYPESAFE_API_URL is not a URL/],
]) {
  test(`jev with TYPESAFE_API_URL ${JSON.stringify(value)} is refused`, (t) => {
    refused(t, [...SHADOW.slice(0, 4), 'jev', ...SHADOW.slice(5)], pattern, { env: { TYPESAFE_API_KEY: 'k', TYPESAFE_API_URL: value } });
  });
}

for (const variable of ['TYPESAFE_API_KEY', 'JEV_API_KEY']) {
  test(`jev with ${variable} reaches the Jev provider's fetch`, (t) => {
    const { dir } = changeRepo(t);
    const result = runCli(t, [...SHADOW.slice(0, 4), 'jev', '--model', 'jev-latest', '--pack', 'change-risk-v1'], {
      cwd: dir,
      env: { [variable]: 'not-a-real-key' },
    });
    assert.equal(result.status, FETCH_EXIT_CODE, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(existsSync(recordFile(dir)), false);
  });
}

test('jev with a key a header cannot carry is refused as configuration', (t) => {
  refused(t, [...SHADOW.slice(0, 4), 'jev', ...SHADOW.slice(5)], /characters a header cannot carry/, { env: { TYPESAFE_API_KEY: 'abc\r' } });
});

for (const [name, question] of [
  ['a Score question', { id: 'severity', kind: 'Score', prompt: 'How severe?', domain: { min: 1, max: 3 }, phases: ['P0'], inputs: ['linesAdded'] }],
  ['questions with different inputs', null],
]) {
  test(`jev with a project pack holding ${name} is refused before anything is sent`, (t) => {
    const shipped = JSON.parse(readFileSync(join(PACKS_DIR, 'change-risk-v1', 'pack.json'), 'utf8'));
    const questions = question
      ? [question]
      : [{ ...shipped.questions[0], inputs: ['linesAdded'] }, { ...shipped.questions[1], inputs: ['filesChanged'] }];
    const pack = { ...shipped, id: 'jev-unsupported', questions, aggregation: { escalateIf: [], allowIf: [] } };
    refused(t, [...SHADOW.slice(0, 4), 'jev', '--model', 'jev-latest', '--pack', 'jev-unsupported'], /--provider jev cannot ask pack jev-unsupported/, {
      env: { TYPESAFE_API_KEY: 'k' },
      prepare: (dir) => {
        mkdirSync(join(dir, '.adlc', 'decision-packs', 'jev-unsupported'), { recursive: true });
        writeFileSync(join(dir, '.adlc', 'decision-packs', 'jev-unsupported', 'pack.json'), JSON.stringify(pack));
      },
    });
  });
}

test('--mock-response without --provider mock is refused', (t) => {
  refused(t, ['evaluate', '--mode', 'shadow', '--provider', 'jev', '--model', 'm', '--pack', 'change-risk-v1', '--mock-response', 'x.json'],
    /--mock-response is valid only with --provider mock/, { env: { TYPESAFE_API_KEY: 'k' } });
  refused(t, ['evaluate', '--mock-response', 'x.json'], /--mock-response is valid only with --provider mock/);
});

test('an unknown --ticket is refused', (t) => {
  refused(t, [...SHADOW, '--ticket', 'T-404'], /unknown --ticket T-404/);
});

test('an unknown --ticket is refused before the mock response or the pack is read', (t) => {
  refused(t, [...SHADOW.slice(0, -1), 'no-such-pack', '--ticket', 'T-404', '--mock-response', 'missing.json'], /unknown --ticket T-404/);
});

test('a ticket ID with an invalid shape is refused', (t) => {
  refused(t, [...SHADOW, '--ticket', '../etc'], /is not a ticket ID/);
});

test('--ticket in a repository without a ticket store is refused', (t) => {
  refused(t, [...SHADOW, '--ticket', 'T-1'], /cannot read the ticket store/, {
    prepare: (dir) => writeFileSync(join(dir, '.adlc', 'tickets.json'), '{broken'),
  });
});

test('a project pack shadowing a shipped one is refused', (t) => {
  refused(t, SHADOW, /shadows the shipped pack "change-risk-v1"/, {
    prepare: (dir) => {
      mkdirSync(join(dir, '.adlc', 'decision-packs', 'change-risk-v1'), { recursive: true });
      writeFileSync(join(dir, '.adlc', 'decision-packs', 'change-risk-v1', 'pack.json'), '{}');
    },
  });
});

test('a symlinked project pack directory shadowing a shipped one is refused', (t) => {
  refused(t, SHADOW, /shadows the shipped pack "change-risk-v1"/, {
    prepare: (dir) => {
      const target = tmp(t, 'decision-linked-pack-');
      writeFileSync(join(target, 'pack.json'), '{}');
      mkdirSync(join(dir, '.adlc', 'decision-packs'), { recursive: true });
      symlinkSync(target, join(dir, '.adlc', 'decision-packs', 'change-risk-v1'));
    },
  });
});

test('a project pack whose prompt carries a credential-shaped string is refused end to end', (t) => {
  const secret = `glpat-${createHash('sha256').update('prompt-secret').digest('hex').slice(0, 24)}`;
  refused(t, [...SHADOW.slice(0, -1), 'leaky-pack'], /a question prompt carries a credential-shaped value/, {
    prepare: (dir) => {
      const pack = JSON.parse(readFileSync(join(PACKS_DIR, 'change-risk-v1', 'pack.json'), 'utf8'));
      pack.id = 'leaky-pack';
      pack.questions[0].prompt = `Rate this. Token: ${secret}`;
      mkdirSync(join(dir, '.adlc', 'decision-packs', 'leaky-pack'), { recursive: true });
      writeFileSync(join(dir, '.adlc', 'decision-packs', 'leaky-pack', 'pack.json'), JSON.stringify(pack));
    },
  });
});

test('a project pack whose question id is credential-shaped is refused end to end, nothing sent', (t) => {
  const id = `ghp_${createHash('sha256').update('question-id-secret').digest('hex').slice(0, 36)}`;
  refused(t, [...SHADOW.slice(0, -1), 'id-pack'], new RegExp(`question id "${id}" must match`), {
    prepare: (dir) => {
      const pack = JSON.parse(readFileSync(join(PACKS_DIR, 'change-risk-v1', 'pack.json'), 'utf8'));
      pack.id = 'id-pack';
      pack.questions.push({ ...structuredClone(pack.questions[0]), id });
      mkdirSync(join(dir, '.adlc', 'decision-packs', 'id-pack'), { recursive: true });
      writeFileSync(join(dir, '.adlc', 'decision-packs', 'id-pack', 'pack.json'), JSON.stringify(pack));
    },
  });
});

test('a sanitization failure exits 1 with one error line and no record', (t) => {
  refused(t, [...SHADOW.slice(0, -1), 'tiny-pack'], /input "\w+" exceeds 4 bytes/, {
    prepare: (dir) => {
      const pack = JSON.parse(readFileSync(join(PACKS_DIR, 'change-risk-v1', 'pack.json'), 'utf8'));
      pack.id = 'tiny-pack';
      pack.limits.fieldBytes = 4;
      mkdirSync(join(dir, '.adlc', 'decision-packs', 'tiny-pack'), { recursive: true });
      writeFileSync(join(dir, '.adlc', 'decision-packs', 'tiny-pack', 'pack.json'), JSON.stringify(pack));
    },
  });
});

test('an unknown pack is refused', (t) => {
  refused(t, [...SHADOW.slice(0, -1), 'no-such-pack'], /no pack "no-such-pack"/);
});

for (const [name, args, pattern] of [
  ['a missing --provider', ['evaluate', '--mode', 'shadow', '--model', 'm', '--pack', 'change-risk-v1'], /needs --provider/],
  ['an unknown provider', ['evaluate', '--mode', 'shadow', '--provider', 'gpt', '--model', 'm', '--pack', 'change-risk-v1'], /unknown --provider "gpt"/],
  ['a missing --model', ['evaluate', '--mode', 'shadow', '--provider', 'mock', '--pack', 'change-risk-v1'], /needs --model/],
  ['a model with spaces', ['evaluate', '--mode', 'shadow', '--provider', 'mock', '--model', 'a b', '--pack', 'change-risk-v1'], /--model "a b" must match/],
  ['a missing --pack', ['evaluate', '--mode', 'shadow', '--provider', 'mock', '--model', 'm'], /needs --pack/],
  ['a malformed pack ID', ['evaluate', '--mode', 'shadow', '--provider', 'mock', '--model', 'm', '--pack', 'Bad_Pack'], /--pack "Bad_Pack" must match/],
  ['a zero --pr', [...SHADOW, '--pr', '0'], /--pr "0" must be a positive integer/],
  ['a non-numeric --pr', [...SHADOW, '--pr', '12a'], /--pr "12a" must be a positive integer/],
  ['an oversized --pr', [...SHADOW, '--pr', '99999999999999999999'], /must be a positive integer/],
  ['an unresolvable --revision', [...SHADOW, '--revision', 'no-such-ref'], /--revision "no-such-ref" does not resolve/],
  ['an unreadable --mock-response', [...SHADOW, '--mock-response', 'missing.json'], /cannot read --mock-response missing.json/],
  ['an unknown flag', [...SHADOW, '--verbose'], /verbose/],
  ['no command', ['--mode', 'off'], /missing command/],
  ['an unknown command', ['run', '--mode', 'off'], /unknown command "run"/],
  ['an extra argument', ['evaluate', 'extra', '--mode', 'off'], /unexpected argument "extra"/],
]) {
  test(`${name} is refused`, (t) => refused(t, args, pattern));
}

test('a run outside a git repository is refused', (t) => {
  const dir = tmp(t, 'decision-nogit-');
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not inside a git work tree/);
});

test('--mode off does nothing: exit 0, no output, no record, even outside a repository', (t) => {
  const dir = tmp(t, 'decision-off-');
  for (const args of [['evaluate'], ['evaluate', '--mode', 'off'], ['evaluate', '--mode', 'off', '--pack', 'whatever']]) {
    const result = runCli(t, args, { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  assert.equal(existsSync(recordFile(dir)), false);
});

test('--mode off inside a repository writes no record', (t) => {
  const { dir } = changeRepo(t);
  const result = runCli(t, ['evaluate', '--mode', 'off'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(recordFile(dir)), false);
});

test('--help prints usage and exits 0', (t) => {
  const result = runCli(t, ['--help'], { cwd: tmp(t, 'decision-help-') });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('adlc decision evaluate --mode shadow --provider <jev|mock> --model <id>'), result.stdout);
  assert.ok(result.stdout.includes('--pack <pack-id> [--revision <rev>] [--ticket <id>] [--pr <number>]'), result.stdout);
  assert.ok(result.stdout.includes('[--mock-response <file>] [--json]'), result.stdout);
  assert.match(result.stdout, /Exit codes:/);
  assert.match(result.stdout, /git-output or sanitization failure before dispatch:\s+nothing was sent and nothing recorded/);
  assert.match(result.stdout, /the record could not be written: the\s+provider may have been asked, but the run was not recorded/);
});

test('a shadow run with the mock prints a one-line summary and exits 0', (t) => {
  const { dir } = changeRepo(t);
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `decision: unknown (status ok) recorded to ${recordFile(dir)}\n`);
});

test('--json prints the run record', (t) => {
  const { dir } = changeRepo(t);
  const result = runCli(t, [...SHADOW, '--json', '--mock-response', responseFile(t, { simulate: 'timeout' })], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.status, 'unknown');
  assert.deepEqual(printed, JSON.parse(readFileSync(recordFile(dir), 'utf8').trim()));
});

test('a record that cannot be written exits 1', (t) => {
  const { dir } = changeRepo(t);
  writeFileSync(join(dir, '.adlc', 'decisions'), 'a file where the directory should be');
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not write the run record/);
});
