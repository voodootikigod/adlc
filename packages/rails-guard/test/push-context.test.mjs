// A push to the default branch is the protected-base ceremony: it lands either
// a merged pull request, already judged by pull-request rules, or an admin's
// direct push. The push run of the rails-guard job judges that range
// (event.before..HEAD), so it must accept what only that ceremony may do:
// completing a ticket, railed or not. Everything else stays as strict as a PR run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { readPrContext, readPushContext, runRailFreezeGate } from '../lib/ci/rail-freeze.mjs';
import { GateDeny } from '../lib/ci/errors.mjs';

const RAILED = { id: 'T-RAILED', title: 'freezes a path', rails: ['src/frozen/**'] };

function writeStore(root, tickets) {
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ schema: 1, tickets }, null, 2) + '\n');
}

/** A repo on `main` holding one railed ticket and a base commit. */
function repo(t) {
  const root = tmp(t, 'rg-push-');
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@test.invalid');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  mkdirSync(join(root, 'src', 'frozen'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'config.json'), JSON.stringify({
    schema: 1, securityMode: 'unsigned-fallback', acknowledgedNewRailBypass: true,
  }) + '\n');
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '');
  writeFileSync(join(root, 'src', 'frozen', 'contract.mjs'), 'export const c = 1;\n');
  writeStore(root, [RAILED]);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  return { root, g, base: g('rev-parse', 'HEAD') };
}

/** Commit everything on the current branch and return the new HEAD. */
function commit(g, message) {
  g('add', '-A');
  g('commit', '-q', '-m', message);
  return g('rev-parse', 'HEAD');
}

/** A push event file for `ref` whose new tip is `after`. */
function pushEvent(t, { after, ref = 'refs/heads/main', defaultBranch = 'main' }) {
  const path = join(tmp(t, 'rg-push-event-'), 'event.json');
  writeFileSync(path, JSON.stringify({ ref, after, repository: { default_branch: defaultBranch } }));
  return path;
}

function pushEnv(t, after, over = {}) {
  return { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: pushEvent(t, { after, ...over }) };
}

const gate = (root, base, env) =>
  runRailFreezeGate({ cwd: root, base, env, stdio: 'pipe' });

const contractDenied = (error) => error instanceof GateDeny && /T-RAILED contract cannot change/.test(error.message);
const deniedIn = (where) => (error) => contractDenied(error) && error.message.endsWith(where);

// ── completion ──────────────────────────────────────────────────────────────────

test('a push to the default branch may complete a RAILED ticket', (t) => {
  const { root, g, base } = repo(t);
  writeStore(root, [{ ...RAILED, completed: true }]);
  const head = commit(g, 'complete T-RAILED');
  assert.equal(gate(root, base, pushEnv(t, head)).status, 0);
});

test('the same completion outside a push context is still denied', (t) => {
  const { root, g, base } = repo(t);
  writeStore(root, [{ ...RAILED, completed: true }]);
  commit(g, 'complete T-RAILED');
  assert.throws(() => gate(root, base, {}), deniedIn('in a PR'));
  assert.throws(() => gate(root, base, { GITHUB_EVENT_NAME: 'pull_request' }), deniedIn('in a PR'));
});

test('a push context is recognised only for the default branch, and only for the HEAD being judged', (t) => {
  const { root, g, base } = repo(t);
  writeStore(root, [{ ...RAILED, completed: true }]);
  const head = commit(g, 'complete T-RAILED');
  for (const [name, env] of [
    ['a push to another branch', pushEnv(t, head, { ref: 'refs/heads/feat' })],
    ['an event for a different commit', pushEnv(t, base)],
    ['a push event under another event name', { ...pushEnv(t, head), GITHUB_EVENT_NAME: 'pull_request' }],
    ['a payload with no default branch', pushEnv(t, head, { defaultBranch: '' })],
    ['no event file', { GITHUB_EVENT_NAME: 'push' }],
  ]) {
    assert.throws(() => gate(root, base, env), contractDenied, name);
  }
});

test('in a push, a ticket may only GAIN completed: true', (t) => {
  for (const [name, headTickets] of [
    ['another field changes with it', [{ ...RAILED, completed: true, title: 'retitled' }]],
    ['completed is not true', [{ ...RAILED, completed: false }]],
    ['completed is a truthy non-boolean', [{ ...RAILED, completed: 'true' }]],
    ['the rails are dropped with it', [{ id: RAILED.id, title: RAILED.title, completed: true }]],
  ]) {
    const { root, g, base } = repo(t);
    writeStore(root, headTickets);
    const head = commit(g, name);
    assert.throws(() => gate(root, base, pushEnv(t, head)), deniedIn('in a push to the default branch'), name);
  }
});

test('in a push, a ticket that was already completed cannot be changed again', (t) => {
  const { root, g } = repo(t);
  writeStore(root, [{ ...RAILED, completed: false }]);
  const base = commit(g, 'base marks completed false');
  writeStore(root, [{ ...RAILED, completed: true }]);
  const head = commit(g, 'flip it');
  assert.throws(() => gate(root, base, pushEnv(t, head)), contractDenied);
});

test('in a push, removing a ticket is still denied', (t) => {
  const { root, g, base } = repo(t);
  writeStore(root, []);
  const head = commit(g, 'drop T-RAILED');
  assert.throws(
    () => gate(root, base, pushEnv(t, head)),
    (error) => error instanceof GateDeny && /T-RAILED cannot be removed/.test(error.message),
  );
});

test('a push that completes a ticket AND edits its railed path is still denied', (t) => {
  const { root, g, base } = repo(t);
  writeStore(root, [{ ...RAILED, completed: true }]);
  writeFileSync(join(root, 'src', 'frozen', 'contract.mjs'), 'export const c = 2;\n');
  const head = commit(g, 'complete and edit in one push');
  assert.equal(gate(root, base, pushEnv(t, head)).status, 2);
});

// ── the context reader ──────────────────────────────────────────────────────────

test('readPushContext returns the pushed HEAD only for a push to the default branch', (t) => {
  const after = 'a'.repeat(40);
  assert.deepEqual(readPushContext(pushEnv(t, after)), { head: after });
  assert.equal(readPushContext(pushEnv(t, after, { ref: 'refs/heads/release' })), null);
  assert.equal(readPushContext({ GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(tmp(t, 'rg-none-'), 'missing.json') }), null);
  assert.equal(readPushContext({}), null);
  const noRepository = join(tmp(t, 'rg-norepo-'), 'event.json');
  writeFileSync(noRepository, JSON.stringify({ ref: 'refs/heads/undefined', after }));
  assert.equal(readPushContext({ GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: noRepository }), null);
});

test('readPrContext treats an event payload of null as no pull request', (t) => {
  const path = join(tmp(t, 'rg-null-event-'), 'event.json');
  writeFileSync(path, 'null');
  assert.equal(readPrContext({ GITHUB_EVENT_PATH: path }), null);
  assert.equal(readPushContext({ GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: path }), null);
});

test('readPrContext reads the author and labels from the pull_request payload', (t) => {
  const path = join(tmp(t, 'rg-pr-event-'), 'event.json');
  writeFileSync(path, JSON.stringify({ pull_request: { user: { login: 'contributor' }, labels: [{ name: 'trust-root-change' }] } }));
  const reviews = JSON.stringify([{ user: { login: 'trusty' }, state: 'APPROVED' }]);
  assert.deepEqual(readPrContext({ GITHUB_EVENT_PATH: path, ADLC_PR_REVIEWS: reviews }), {
    author: 'contributor',
    labels: ['trust-root-change'],
    reviews: [{ user: 'trusty', state: 'APPROVED', submittedAt: undefined }],
  });
});
