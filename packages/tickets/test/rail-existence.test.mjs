// A rail freezes the files it matches. A rail that matches no file freezes
// nothing, so the build it was meant to constrain runs unguarded; the store
// refuses such a rail when a ticket is created or a rail is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, tmp } from '@adlc/core/test-kit';
import { DirectoryTicketStore, TicketService } from '../index.mjs';
import { repositoryFiles } from '../lib/rail-existence.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

/** A git repository holding a tracked lib/score.mjs and an untracked lib/draft.mjs. */
function repoWithFiles(t) {
  const { dir, git } = gitRepo(t, 'adlc-rail-exists-');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'score.mjs'), 'export const score = 1;\n');
  git('add', 'lib/score.mjs');
  git('commit', '-q', '-m', 'seed');
  writeFileSync(join(dir, 'lib', 'draft.mjs'), 'export const draft = 1;\n');
  const path = writeDirectory(dir, [ticket('A', { rails: ['lib/score.mjs'] })]);
  return { root: dir, service: new TicketService(new DirectoryTicketStore(path), { root: dir }) };
}

const matchesNothing = (rail) => (error) =>
  error.code === 'RAIL_MATCHES_NOTHING' && error.message.includes(rail);

test('create refuses a rail that matches no file in the repository', (t) => {
  const { service } = repoWithFiles(t);
  assert.throws(() => service.planCreate(ticket('NEW', { rails: ['lib/graph.mjs'] })), matchesNothing('lib/graph.mjs'));
  assert.throws(() => service.planCreate(ticket('NEW', { rails: ['src/**'] })), matchesNothing('src/**'));
});

test('a batch create refuses a rail that matches no file', (t) => {
  const { service } = repoWithFiles(t);
  assert.throws(
    () => service.planCreateBatch([ticket('OK', { rails: ['lib/score.mjs'] }), ticket('BAD', { rails: ['lib/missing.mjs'] })]),
    matchesNothing('lib/missing.mjs'),
  );
});

test('a rail naming an existing file, an untracked file, or a glob with a match is accepted', (t) => {
  const { service } = repoWithFiles(t);
  for (const rail of ['lib/score.mjs', 'lib/draft.mjs', 'lib/**', 'lib/*.mjs']) {
    assert.equal(service.planCreate(ticket(`T${rail.length}`, { rails: [rail] })).operation, 'create', rail);
  }
});

test('an update refuses an added rail that matches nothing but keeps a rail the ticket already had', (t) => {
  const { root, service } = repoWithFiles(t);
  assert.throws(
    () => service.planUpdate('A', ticket('A', { rails: ['lib/score.mjs', 'lib/gone.mjs'] })),
    matchesNothing('lib/gone.mjs'),
  );
  // A rail whose file has since been deleted is not re-checked on an unrelated edit.
  const stale = writeDirectory(root, [ticket('S', { rails: ['lib/removed.mjs'] })]);
  const staleService = new TicketService(new DirectoryTicketStore(stale), { root });
  const plan = staleService.planUpdate('S', ticket('S', { rails: ['lib/removed.mjs'], title: 'renamed' }));
  assert.equal(plan.operation, 'update');
});

test('outside a git repository the check does not run', (t) => {
  const root = tmp(t, 'adlc-rail-norepo-');
  const path = writeDirectory(root, []);
  const service = new TicketService(new DirectoryTicketStore(path), { root });
  assert.equal(service.planCreate(ticket('NEW', { rails: ['anything/**'] })).operation, 'create');
});

test('a rail matching only a file git ignores is refused', (t) => {
  const { root, service } = repoWithFiles(t);
  writeFileSync(join(root, '.gitignore'), 'build/\n');
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build', 'out.mjs'), 'export {};\n');
  assert.throws(() => service.planCreate(ticket('NEW', { rails: ['build/out.mjs'] })), matchesNothing('build/out.mjs'));
});

test('the file listing runs git with a bounded timeout and reads its NUL-separated output', () => {
  const calls = [];
  const spawn = (cmd, args, options) => { calls.push({ cmd, args, options }); return { status: 0, stdout: 'a.mjs\0dir/b.mjs\0' }; };
  assert.deepEqual(repositoryFiles('/repo', { spawn }), ['a.mjs', 'dir/b.mjs']);
  assert.equal(calls[0].cmd, 'git');
  assert.ok(Number.isFinite(calls[0].options.timeout) && calls[0].options.timeout > 0, 'git ran without a timeout');
  assert.equal(repositoryFiles('/repo', { spawn: () => ({ error: new Error('ETIMEDOUT') }) }), null);
  assert.equal(repositoryFiles('/repo', { spawn: () => ({ status: 128, stdout: '' }) }), null);
});
