import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  name, pool, toPermissionRule, buildSettings, provision, dispatch,
} from '../lib/adapters/claude-code.mjs';

test('adapter identity', () => {
  assert.equal(name, 'claude-code');
  assert.equal(pool, 'default');
});

test('toPermissionRule wraps commands in Bash() rule form (premortem F1)', () => {
  assert.equal(toPermissionRule('npm test'), 'Bash(npm test)');
  assert.equal(toPermissionRule('npm run build:*'), 'Bash(npm run build:*)');
});

test('buildSettings allowlists gate/init/allowed commands + read-only git, never git commit', () => {
  const s = buildSettings({ init: 'npm install', gate: { build: 'npm run build', test: 'npm test' }, allowedCommands: ['node --test'] });
  const allow = s.permissions.allow;
  assert.ok(allow.includes('Bash(npm install)'));
  assert.ok(allow.includes('Bash(npm run build)'));
  assert.ok(allow.includes('Bash(npm test)'));
  assert.ok(allow.includes('Bash(node --test)'));
  assert.ok(allow.includes('Bash(git status)'));
  assert.ok(!allow.some((r) => /git commit/.test(r)), 'the worker must NOT be allowed to commit');
});

test('provision writes only the allowlist settings file to the worktree .claude dir (AC4)', () => {
  const written = [];
  const r = provision({
    worktree: '/wt',
    config: { gate: { test: 'npm test' } },
    writeJson: (path, obj) => written.push({ path, obj }),
  });
  assert.equal(written.length, 1, 'provision writes exactly one file');
  assert.equal(written[0].path, '/wt/.claude/settings.local.json');
  assert.deepEqual(r.settings, written[0].obj);
});

test('dispatch spawns claude -p acceptEdits in the worktree with model-plane env (AC4 / K2)', () => {
  let captured;
  const res = dispatch({
    worktree: '/wt',
    prompt: 'build ticket T42',
    timeoutMs: 60000,
    env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T42', ANTHROPIC_API_KEY: 'sk' },
    exec: (cmd, args, opts) => { captured = { cmd, args, opts }; return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; },
  });
  assert.equal(captured.cmd, 'claude');
  assert.ok(captured.args.includes('-p'));
  assert.ok(captured.args.includes('--permission-mode') && captured.args.includes('acceptEdits'));
  assert.equal(captured.opts.cwd, '/wt', 'cwd must be the worktree');
  assert.equal(captured.opts.env.ADLC_P4_ENFORCEMENT, '1');
  assert.equal(captured.opts.env.ADLC_TICKET, 'T42');
  assert.equal(captured.opts.env.ANTHROPIC_API_KEY, 'sk', 'model plane retains provider auth (K2) — NOT stripped/sandboxed');
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /TICKET-DONE/);
});

test('dispatch maps a timeout to a failed-strike outcome (AC4)', () => {
  const res = dispatch({
    worktree: '/wt', prompt: 'x', timeoutMs: 10, env: {},
    exec: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: 'timed out' }),
  });
  assert.equal(res.timedOut, true);
  assert.notEqual(res.exitCode, 0, 'a timeout must be a non-zero (failed) outcome');
});
