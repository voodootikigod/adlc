// churn() and coChange() key their counts by the real repo-relative path,
// the same key a directory walker produces, whatever bytes the name holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, churn, coChange, pairKey } from '../lib/git.mjs';
import { tmp } from '../lib/test-kit.mjs';

const NON_ASCII = 'señal.mjs';
const SPACED = 'with space.mjs';
const QUOTED = 'say "hi".mjs';
const MARKERISH = '--COMMIT--';
// A root file whose name is a plausible textual marker must still count as a path.
const WORDISH = 'undefined.mjs';

function repo(t) {
  const dir = tmp(t, 'adlc-git-log-nonascii-');
  const g = (args) => git(args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'commit.gpgsign', 'false']);
  const commit = (files, msg) => {
    for (const f of files) appendFileSync(join(dir, f), `${msg}\n`);
    g(['add', '-A']);
    g(['commit', '-q', '-m', msg]);
  };
  commit([NON_ASCII, 'plain.mjs'], 'one');
  commit([NON_ASCII, QUOTED], 'two');
  g(['commit', '-q', '--allow-empty', '-m', 'empty']);
  commit([SPACED, MARKERISH, WORDISH], 'three');
  writeFileSync(join(dir, 'plain.mjs'), 'changed\n');
  commit(['plain.mjs'], 'four');
  return dir;
}

test('churn counts a non-ASCII or quote-bearing path under its real name', (t) => {
  const dir = repo(t);
  assert.deepEqual(churn(1000, dir), {
    [NON_ASCII]: 2,
    'plain.mjs': 2,
    [QUOTED]: 1,
    [SPACED]: 1,
    [MARKERISH]: 1,
    [WORDISH]: 1,
  });
});

test('coChange groups files per commit under their real names', (t) => {
  const dir = repo(t);
  const { pairCounts, fileCounts } = coChange(500, dir);
  assert.deepEqual(fileCounts, {
    [NON_ASCII]: 2,
    'plain.mjs': 2,
    [QUOTED]: 1,
    [SPACED]: 1,
    [MARKERISH]: 1,
    [WORDISH]: 1,
  });
  assert.deepEqual(pairCounts, {
    [pairKey(NON_ASCII, 'plain.mjs')]: 1,
    [pairKey(NON_ASCII, QUOTED)]: 1,
    [pairKey(SPACED, MARKERISH)]: 1,
    [pairKey(SPACED, WORDISH)]: 1,
    [pairKey(MARKERISH, WORDISH)]: 1,
  });
});

test('churn honours the commit limit', (t) => {
  const dir = repo(t);
  assert.deepEqual(churn(1, dir), { 'plain.mjs': 1 });
});
