// scaffold-target.test.mjs — the scaffolder must refuse implausible targets.
//
// The target defaults to `.`, so running /adlc-init from the wrong directory
// wrote a `.adlc/` — config AND a ticket store — wherever the shell happened to
// be. In $HOME that is especially costly: `.adlc/` is the marker meaning "this
// directory is an ADLC repo", so a `~/.adlc` makes $HOME read as a repo and
// captures every project beneath it. That is exactly how a ticket store ended
// up at ~/.adlc/tickets/.store.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'scaffold-cli.mjs');

function runScaffold(target, { home = target, extraArgs = [] } = {}) {
  return spawnSync(process.execPath, [CLI, target, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

test('refuses $HOME and writes nothing there', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-scaffold-home-'));
  try {
    // A git repo, so ONLY the home-directory rule can be what rejects it.
    mkdirSync(join(home, '.git'), { recursive: true });
    const r = runScaffold(home, { home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to scaffold/i);
    assert.match(r.stderr, /home directory/i);
    assert.equal(existsSync(join(home, '.adlc')), false, 'refused run must leave no .adlc behind');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--force overrides the $HOME refusal for a deliberate dotfiles layout', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-scaffold-forced-'));
  try {
    mkdirSync(join(home, '.git'), { recursive: true });
    const r = runScaffold(home, { home, extraArgs: ['--force'] });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, '.adlc', 'config.json')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Scaffolding an empty directory and running `git init` afterwards is a
// legitimate order of operations, so this warns rather than blocking.
test('a not-yet-git directory warns but still scaffolds', () => {
  const plain = mkdtempSync(join(tmpdir(), 'adlc-scaffold-plain-'));
  try {
    const r = runScaffold(plain, { home: join(plain, 'elsewhere') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not a git repository yet/i);
    assert.ok(existsSync(join(plain, '.adlc', 'config.json')));
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('an ordinary git repo still scaffolds', () => {
  const repo = mkdtempSync(join(tmpdir(), 'adlc-scaffold-repo-'));
  try {
    mkdirSync(join(repo, '.git'), { recursive: true });
    const r = runScaffold(repo, { home: join(repo, 'elsewhere') });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(repo, '.adlc', 'config.json')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
