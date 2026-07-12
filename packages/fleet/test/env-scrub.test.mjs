import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoCommandEnv, modelPlaneEnv } from '../lib/env-scrub.mjs';

const base = {
  PATH: '/usr/bin',
  HOME: '/home/real',
  ADLC_TICKET: 'T42',
  ADLC_P4_ENFORCEMENT: '1',
  OPENAI_API_KEY: 'sk-openai',
  ANTHROPIC_API_KEY: 'sk-anthropic',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GITHUB_TOKEN: 'ghtok',
  MY_APP_SECRET: 'shh',
  RANDOM_VAR: 'value',
};

test('repo-command plane strips ALL provider keys and cloud creds (AC11)', () => {
  const env = repoCommandEnv(base, { syntheticHome: '/wt/.home' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.MY_APP_SECRET, undefined);
});

test('repo-command plane retains PATH and ADLC_*; sets synthetic HOME (AC11)', () => {
  const env = repoCommandEnv(base, { syntheticHome: '/wt/.home' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ADLC_TICKET, 'T42');
  assert.equal(env.ADLC_P4_ENFORCEMENT, '1');
  assert.equal(env.HOME, '/wt/.home', 'HOME must be the synthetic in-worktree home, not the real one');
  assert.notEqual(env.HOME, '/home/real');
});

test('repo-command plane drops arbitrary non-secret vars by default', () => {
  const env = repoCommandEnv(base, { syntheticHome: '/wt/.home' });
  assert.equal(env.RANDOM_VAR, undefined);
});

test('repo-command plane honors an explicit passthrough allowlist', () => {
  const env = repoCommandEnv(base, { syntheticHome: '/wt/.home', passthrough: ['MY_APP_SECRET'] });
  assert.equal(env.MY_APP_SECRET, 'shh', 'a config-named key may pass through');
});

test('repo-command plane without a synthetic home drops HOME entirely (no real-home leak)', () => {
  const env = repoCommandEnv(base, {});
  assert.equal(env.HOME, undefined);
});

test('model plane keeps only the named model-auth key, strips other secrets', () => {
  const env = modelPlaneEnv(base, {
    modelAuthKey: 'ANTHROPIC_API_KEY',
    extra: { ADLC_TICKET: 'T42', ADLC_P4_ENFORCEMENT: '1' },
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-anthropic', 'worker keeps its own model auth');
  assert.equal(env.OPENAI_API_KEY, undefined, 'unrelated provider key stripped');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'cloud cred stripped');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/real', 'model plane keeps real HOME so it can read its session auth');
  assert.equal(env.ADLC_TICKET, 'T42');
});

test('model plane with no model key strips every secret (subscription-auth case)', () => {
  const env = modelPlaneEnv(base, {});
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, '/usr/bin');
});
