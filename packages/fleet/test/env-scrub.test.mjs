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

// The ledger signing key authenticates cross-model attestations. A worker that
// could read it could forge the very evidence the merge gate trusts, so no
// `modelAuthKey` may unlock it — not even one an operator passes deliberately.
// This is the last line of defence behind making `modelAuthKey` operator-local:
// even a correct config cannot turn the trust anchor into a worker credential.
test('ADLC_MANIFEST_KEY is never exemptable, whoever names it', () => {
  const src = { PATH: '/usr/bin', HOME: '/home/op', ADLC_MANIFEST_KEY: 'signing-key', ANTHROPIC_API_KEY: 'sk-real' };

  // Named as the model auth key — still stripped.
  assert.equal(modelPlaneEnv(src, { modelAuthKey: 'ADLC_MANIFEST_KEY' }).ADLC_MANIFEST_KEY, undefined);
  // And naming it does not smuggle other secrets through either.
  assert.equal(modelPlaneEnv(src, { modelAuthKey: 'ADLC_MANIFEST_KEY' }).ANTHROPIC_API_KEY, undefined);
  // A genuine provider credential still works.
  assert.equal(modelPlaneEnv(src, { modelAuthKey: 'ANTHROPIC_API_KEY' }).ANTHROPIC_API_KEY, 'sk-real');
  // ...and does not drag the signing key along with it.
  assert.equal(modelPlaneEnv(src, { modelAuthKey: 'ANTHROPIC_API_KEY' }).ADLC_MANIFEST_KEY, undefined);
});

test('an arbitrary host secret can only be exempted by naming it explicitly', () => {
  const src = { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'aws' };
  const none = modelPlaneEnv(src, {});
  assert.equal(none.GITHUB_TOKEN, undefined, 'secrets are stripped by default');
  assert.equal(none.AWS_SECRET_ACCESS_KEY, undefined);
  // Exempting one does not exempt the rest.
  const one = modelPlaneEnv(src, { modelAuthKey: 'GITHUB_TOKEN' });
  assert.equal(one.GITHUB_TOKEN, 'ghp_x');
  assert.equal(one.AWS_SECRET_ACCESS_KEY, undefined);
});
