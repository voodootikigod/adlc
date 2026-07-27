// Concern: load-env-local.mjs — the LOCAL .env.local → ADLC_MANIFEST_KEY convenience.
// The security-critical properties are (2) never override an existing value and (3) never load
// under CI, because the trust-root gate runs with cwd = the PR-controlled tree.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKeyFromEnvText, isCIEnv, loadManifestKeyFromEnvLocal, MANIFEST_KEY } from '../lib/load-env-local.mjs';

function withEnvLocal(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-envlocal-'));
  try {
    if (contents !== null) writeFileSync(join(dir, '.env.local'), contents);
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('readKeyFromEnvText — only ADLC_MANIFEST_KEY, tolerant parsing', () => {
  it('reads a bare KEY=value', () => {
    assert.equal(readKeyFromEnvText('ADLC_MANIFEST_KEY=abc123'), 'abc123');
  });
  it('accepts an `export` prefix and strips one pair of quotes', () => {
    assert.equal(readKeyFromEnvText('export ADLC_MANIFEST_KEY="q u o t e d"'), 'q u o t e d');
    assert.equal(readKeyFromEnvText("ADLC_MANIFEST_KEY='single'"), 'single');
  });
  it('ignores comments, blanks, and OTHER keys entirely', () => {
    const text = '# a comment\n\nOTHER=nope\nADLC_MANIFEST_KEY=real\nADLC_MANIFEST_KEY=second-wins-not\n';
    assert.equal(readKeyFromEnvText(text), 'real'); // first match wins
    assert.equal(readKeyFromEnvText('SOMETHING_ELSE=x\n'), null); // no target key present
  });
  it('never returns another variable even if it contains the substring', () => {
    assert.equal(readKeyFromEnvText('NOT_ADLC_MANIFEST_KEY=x\nMY_ADLC_MANIFEST_KEY_2=y\n'), null);
  });
});

describe('isCIEnv', () => {
  it('true under GitHub Actions', () => assert.equal(isCIEnv({ GITHUB_ACTIONS: 'true' }), true));
  it('true when CI is a truthy value', () => {
    assert.equal(isCIEnv({ CI: 'true' }), true);
    assert.equal(isCIEnv({ CI: '1' }), true);
  });
  it('false when CI is unset or explicitly falsey', () => {
    assert.equal(isCIEnv({}), false);
    assert.equal(isCIEnv({ CI: '' }), false);
    assert.equal(isCIEnv({ CI: 'false' }), false);
    assert.equal(isCIEnv({ CI: '0' }), false);
  });
});

describe('loadManifestKeyFromEnvLocal — set only when safe', () => {
  it('sets the key from .env.local when unset and not CI', () => {
    withEnvLocal('ADLC_MANIFEST_KEY=from-file', (dir) => {
      const env = {};
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env, isCI: false }), true);
      assert.equal(env[MANIFEST_KEY], 'from-file');
    });
  });

  it('NEVER overrides an already-set value (a real exported/secret key wins)', () => {
    withEnvLocal('ADLC_MANIFEST_KEY=from-file', (dir) => {
      const env = { ADLC_MANIFEST_KEY: 'already-here' };
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env, isCI: false }), false);
      assert.equal(env[MANIFEST_KEY], 'already-here');
    });
  });

  it('NEVER overrides an EXPLICITLY EMPTY value — presence wins, so it stays empty (#354 loader F1)', () => {
    // ADLC_MANIFEST_KEY='' is a deliberate "no key → fail closed"; the file must not fill it.
    withEnvLocal('ADLC_MANIFEST_KEY=from-file', (dir) => {
      const env = { ADLC_MANIFEST_KEY: '' };
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env, isCI: false }), false);
      assert.equal(env[MANIFEST_KEY], ''); // stayed empty; the file did NOT overwrite it
    });
  });

  it('NEVER loads under CI — even with a file present and the env unset (the forge guard)', () => {
    withEnvLocal('ADLC_MANIFEST_KEY=attacker-supplied', (dir) => {
      const env = {};
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env, isCI: true }), false);
      assert.equal(env[MANIFEST_KEY], undefined);
    });
  });

  it('CI detection defaults from the env: GITHUB_ACTIONS blocks the load', () => {
    withEnvLocal('ADLC_MANIFEST_KEY=attacker-supplied', (dir) => {
      const env = { GITHUB_ACTIONS: 'true' }; // isCI derived from env, not passed
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env }), false);
      assert.equal(env[MANIFEST_KEY], undefined);
    });
  });

  it('an EMPTY secret in CI does not fall through to the file (CI checked before the value)', () => {
    withEnvLocal('ADLC_MANIFEST_KEY=attacker-supplied', (dir) => {
      const env = { GITHUB_ACTIONS: 'true', ADLC_MANIFEST_KEY: '' }; // unconfigured secret → empty
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env }), false);
      assert.equal(env[MANIFEST_KEY], ''); // stays empty → bin fails closed, never the file value
    });
  });

  it('no file → no-op', () => {
    withEnvLocal(null, (dir) => {
      const env = {};
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env, isCI: false }), false);
      assert.equal(env[MANIFEST_KEY], undefined);
    });
  });

  it('file present but no/empty ADLC_MANIFEST_KEY → no-op', () => {
    withEnvLocal('OTHER=x\nADLC_MANIFEST_KEY=\n', (dir) => {
      const env = {};
      assert.equal(loadManifestKeyFromEnvLocal({ cwd: dir, env, isCI: false }), false);
      assert.equal(env[MANIFEST_KEY], undefined);
    });
  });
});
