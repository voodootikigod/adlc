// The forecast walks and mines co-change from the git repository root, whatever
// the working directory. Ticket scopes and `git log --name-only` paths are both
// repo-root-relative; `--tickets` and `--graph-coupling` still resolve from cwd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitRepo, tmp } from '@adlc/core/test-kit';

const BIN = fileURLToPath(new URL('../bin/merge-forecast.mjs', import.meta.url));

function coChangedRepo(t) {
  const { dir, git } = gitRepo(t, 'mf-subdir-');
  mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'b'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, 'packages', 'a', 'a.js'), `export const a = ${i};\n`);
    writeFileSync(join(dir, 'packages', 'b', 'b.js'), `export const b = ${i};\n`);
    git('add', '.');
    git('commit', '-m', `c${i}`);
  }
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [
      { id: 'T1', title: 'A', scope: ['packages/a/**'] },
      { id: 'T2', title: 'B', scope: ['packages/b/**'] },
    ],
  }));
  return dir;
}

function forecast(cwd, args) {
  const res = spawnSync(process.execPath, [BIN, '--json', ...args], { cwd, encoding: 'utf8', timeout: 20000 });
  return { code: res.status, out: res.stdout ? JSON.parse(res.stdout) : null, stderr: res.stderr };
}

test('from a subdirectory the forecast matches the one from the repo root', (t) => {
  const dir = coChangedRepo(t);
  const atRoot = forecast(dir, []);
  assert.equal(atRoot.code, 2, `precondition: root forecast gate-fails: ${atRoot.stderr}`);
  assert.match(atRoot.out.gateFailures.join(' '), /T1.T2.*co-change/);

  const fromSub = forecast(join(dir, 'packages', 'a'), ['--tickets', '../../.adlc/tickets.json']);
  assert.equal(fromSub.code, 2, `stderr=${fromSub.stderr}`);
  assert.deepEqual(fromSub.out.gateFailures, atRoot.out.gateFailures);
  assert.deepEqual(fromSub.out.warnings, atRoot.out.warnings);
  assert.deepEqual(fromSub.out.pairs, atRoot.out.pairs);
});

test('--graph-coupling resolves from the working directory', (t) => {
  const dir = coChangedRepo(t);
  const sub = join(dir, 'packages', 'a');
  writeFileSync(join(sub, 'coupling.json'), '{not json');
  const res = forecast(sub, ['--tickets', '../../.adlc/tickets.json', '--graph-coupling', 'coupling.json']);
  assert.ok(
    res.out.warnings.some((w) => w.startsWith('graph-coupling skipped: failed to parse') && w.includes(join(sub, 'coupling.json'))),
    JSON.stringify(res.out.warnings),
  );
});

test('outside a git repository the working directory is still the forecast root', (t) => {
  const dir = tmp(t, 'mf-nogit-');
  mkdirSync(join(dir, 'src', 'a'), { recursive: true });
  mkdirSync(join(dir, 'src', 'b'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a', 'x.js'), '');
  writeFileSync(join(dir, 'src', 'b', 'y.js'), '');
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({
    tickets: [
      { id: 'T1', title: 'A', scope: ['src/a/**'] },
      { id: 'T2', title: 'B', scope: ['src/b/**'] },
    ],
  }));
  const res = forecast(dir, ['--tickets', 'tickets.json']);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.out.warnings.includes('co-change skipped: not a git repo'), JSON.stringify(res.out.warnings));
  assert.ok(!res.out.warnings.some((w) => w.includes('matches 0 files')), JSON.stringify(res.out.warnings));
});

test('a git directory with no resolvable work-tree root is an operational error', (t) => {
  const dir = coChangedRepo(t);
  const res = spawnSync(process.execPath, [BIN, '--tickets', '../.adlc/tickets.json'], {
    cwd: join(dir, '.git'), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /cannot resolve the git repository root/);
});
