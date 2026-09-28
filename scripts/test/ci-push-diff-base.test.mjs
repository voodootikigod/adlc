// The rails-guard job's diff base. A pull_request run judges the PR against its
// base branch; a push run judges exactly the pushed range (event.before..HEAD).
// A freshly fetched origin/main is the wrong base on push: equal to HEAD when
// nothing raced (a vacuous pass), and including a LATER push when one did (a
// false red). Drives the real `Resolve diff base` step script from ci.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
const ZERO = '0'.repeat(40);

// The rails-guard job's text: from its key to the next top-level job key.
function jobText(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `job ${name} not found in ci.yml`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end);
}

// The `run: |` body of the named step, dedented.
function stepScript(job, stepName) {
  const start = job.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(start >= 0, `step "${stepName}" not found`);
  const runAt = job.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  const indent = job[runAt].match(/^\s*/)[0].length + 2;
  const body = [];
  for (let i = runAt + 1; i < job.length; i++) {
    const l = job[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const JOB = jobText('rails-guard');
const SCRIPT = stepScript(JOB, 'Resolve diff base');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(dir, path, body, msg) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), body);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function repo(t) {
  const dir = tmp(t, 'ci-base-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'a@b.c']);
  git(dir, ['config', 'user.name', 'x']);
  return dir;
}

function resolve(t, dir, env) {
  const out = join(tmp(t, 'ci-out-'), 'github_output');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', '-c', SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...GIT_ENV, BASE_REF: '', BEFORE: '', ...env, GITHUB_OUTPUT: out },
  });
  const base = readFileSync(out, 'utf8').match(/^base=(.*)$/m)?.[1] ?? null;
  return { status: r.status, base, stderr: r.stderr, stdout: r.stdout };
}

test('push: the base is event.before, so a multi-commit push is judged as one range', (t) => {
  const dir = repo(t);
  const before = commit(dir, 'a.txt', '1\n', 'base');
  commit(dir, 'a.txt', '2\n', 'pushed 1');
  commit(dir, 'a.txt', '3\n', 'pushed 2');
  const r = resolve(t, dir, { BEFORE: before });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.base, before);
});

for (const [label, before] of [
  ['the all-zero sha (branch creation)', ZERO],
  ['a sha absent from the clone (force push)', 'a'.repeat(40)],
  ['a malformed value', '$(touch pwned)'],
  ['an empty value', ''],
]) {
  test(`push: ${label} falls back to HEAD^1, not to HEAD`, (t) => {
    const dir = repo(t);
    const parent = commit(dir, 'a.txt', '1\n', 'base');
    commit(dir, 'a.txt', '2\n', 'pushed');
    const r = resolve(t, dir, { BEFORE: before });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.base, parent);
    assert.match(r.stdout, /::warning::/);
  });
}

test('push: no usable before-sha and a root commit fails closed with no base', (t) => {
  const dir = repo(t);
  commit(dir, 'a.txt', '1\n', 'root');
  const r = resolve(t, dir, { BEFORE: ZERO });
  assert.notEqual(r.status, 0);
  assert.equal(r.base, null);
  assert.match(r.stdout + r.stderr, /::error::/);
});

test('pull_request: the base is the fetched origin/<base_ref>', (t) => {
  const origin = repo(t);
  const tip = commit(origin, 'a.txt', '1\n', 'base');
  const dir = tmp(t, 'ci-clone-');
  execFileSync('git', ['clone', '-q', origin, dir], { env: GIT_ENV });
  commit(origin, 'a.txt', '2\n', 'moved on');
  const r = resolve(t, dir, { BASE_REF: 'main', BEFORE: tip });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.base, 'origin/main');
  assert.equal(git(dir, ['rev-parse', 'origin/main']), git(origin, ['rev-parse', 'HEAD']));
});

test('every base-diffing gate consumes the resolved base, not origin/$BASE_REF', () => {
  const text = JOB.join('\n');
  assert.match(text, /- name: Resolve diff base\n\s+id: diff-base\n/);
  assert.doesNotMatch(text, /node \S+ "origin\/\$BASE_REF"/, 'no gate may diff against origin/$BASE_REF directly');
  for (const step of ['Rail-freeze gate', 'Findings-ledger append-only gate', 'Reviewer-directed-comment gate']) {
    const at = JOB.findIndex((l) => l.trim() === `- name: ${step}`);
    assert.ok(at > JOB.findIndex((l) => l.trim() === '- name: Resolve diff base'), `${step} must follow the resolver`);
    const next = JOB.findIndex((l, i) => i > at && /^\s+- name: /.test(l));
    const body = JOB.slice(at, next < 0 ? JOB.length : next).join('\n');
    assert.match(body, /DIFF_BASE: \$\{\{ steps\.diff-base\.outputs\.base \}\}/, step);
    assert.match(body, /"\$DIFF_BASE"/, step);
    assert.doesNotMatch(body, /origin\/\$BASE_REF/, step);
  }
});

test('push: a pushed range that edits a frozen rail is judged, not passed vacuously', (t) => {
  const dir = repo(t);
  commit(dir, '.adlc/tickets.json', JSON.stringify({ tickets: [{ id: 'T1', title: 'fixture', rails: ['src/critical/**'] }] }), 'base');
  commit(dir, 'src/critical/auth.mjs', 'orig\n', 'seed');
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const pushedFrom = git(dir, ['rev-parse', 'HEAD']);
  commit(dir, 'src/critical/auth.mjs', 'changed\n', 'direct push');
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const r = resolve(t, dir, { BEFORE: pushedFrom });
  assert.equal(r.base, pushedFrom);
  const gate = (base) => spawnSync(process.execPath, [join(REPO, 'scripts/rails-guard-ci.mjs'), base], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, RAILS_BASE: '', BASE_REF: '', GITHUB_EVENT_PATH: '' },
  }).status;
  assert.equal(gate('origin/main'), 0, 'the old base (origin/main == HEAD) is vacuous');
  assert.equal(gate(r.base), 2, 'the pushed range touches a frozen rail');
});
