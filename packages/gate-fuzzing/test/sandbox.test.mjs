// §1.7 — sandbox profiles, allowlist, no-sandbox refuse (F6)
// These tests operate on the sandbox module logic without actually spawning
// a bwrap/sandbox-exec process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSandboxedArgs,
  detectSandbox,
  buildMacOSSbpl,
  escapeSeatbeltPath,
  seatbeltWrap,
  SANDBOX_PROFILES,
  sanitizeCandidateEnv,
  spawnSandboxed,
  spawnCandidateCmd,
} from '../lib/sandbox.mjs';

test('detectSandbox returns sandbox type or null', () => {
  // We cannot guarantee which sandbox is available in CI, but the function
  // must return one of: 'bwrap', 'sandbox-exec', or null
  const result = detectSandbox({ which: (cmd) => cmd === 'bwrap' ? '/usr/bin/bwrap' : null });
  assert.ok(result === 'bwrap' || result === null);

  const result2 = detectSandbox({ which: (cmd) => cmd === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null });
  assert.ok(result2 === 'sandbox-exec' || result2 === null);

  const result3 = detectSandbox({ which: () => null });
  assert.equal(result3, null);
});

test('buildSandboxedArgs for bwrap produces correct argv', () => {
  const cloneDir = '/tmp/gate-fuzzing-test-clone';
  const cmdArgs = ['node', '--test', 'test/foo.mjs'];
  const args = buildSandboxedArgs('bwrap', cloneDir, cmdArgs);

  assert.ok(Array.isArray(args), 'Must return an array');
  // Must start with 'bwrap'
  assert.equal(args[0], 'bwrap');
  // Must include network denial (--unshare-all)
  assert.ok(args.includes('--unshare-all'), 'Must unshare all (deny network)');
  // Must NOT include --share-net (network must be unshared/denied)
  assert.ok(!args.includes('--share-net'), 'Must not share network');
  // Must include --ro-bind / /
  const roBindIdx = args.indexOf('--ro-bind');
  assert.ok(roBindIdx !== -1, 'Must include --ro-bind / /');
  // Clone dir must be bound writable
  assert.ok(args.includes('--bind'), 'Must include --bind for clone dir');
  // Must include --die-with-parent
  assert.ok(args.includes('--die-with-parent'), 'Must include --die-with-parent');
  // The actual command must appear at the end after --
  const dashDashIdx = args.indexOf('--');
  assert.ok(dashDashIdx !== -1, 'Must include -- before command');
  assert.deepEqual(args.slice(dashDashIdx + 1), cmdArgs, 'Command must appear after --');
});

test('buildSandboxedArgs for sandbox-exec produces correct SBPL and argv', () => {
  const cloneDir = '/tmp/gate-fuzzing-test-clone';
  const cmdArgs = ['node', '--test', 'test/foo.mjs'];
  const args = buildSandboxedArgs('sandbox-exec', cloneDir, cmdArgs);

  assert.ok(Array.isArray(args), 'Must return an array');
  assert.equal(args[0], 'sandbox-exec');
  // Must include -p flag for SBPL profile
  assert.ok(args.includes('-p'), 'Must include -p for SBPL');
  const pIdx = args.indexOf('-p');
  const sbpl = args[pIdx + 1];
  // SBPL must deny network
  assert.ok(sbpl.includes('deny network*'), 'SBPL must deny network*');
  // SBPL must allow process
  assert.ok(sbpl.includes('allow process*'), 'SBPL must allow process*');
  // SBPL must allow file-write* for clone dir
  assert.ok(sbpl.includes(cloneDir), 'SBPL must reference clone dir for writes');
  // Command must be appended
  assert.ok(args.includes('node'), 'Command must be in args');
});

test('buildMacOSSbpl includes deny default, deny network, allow file-write for cloneDir', () => {
  const cloneDir = '/tmp/specific-clone-dir';
  const sbpl = buildMacOSSbpl(cloneDir);

  assert.ok(sbpl.includes('(version 1)'));
  assert.ok(sbpl.includes('(deny default)'));
  assert.ok(sbpl.includes('(allow process*)'));
  assert.ok(sbpl.includes('(allow file-read*)'));
  assert.ok(sbpl.includes('(deny network*)'));
  assert.ok(sbpl.includes(`(subpath "${cloneDir}")`));
  assert.ok(sbpl.includes('(allow file-write-data (path "/dev/null"))'));
});

test('SANDBOX_PROFILES exports bwrap and sandbox-exec configs', () => {
  assert.ok(SANDBOX_PROFILES['bwrap'], 'Must have bwrap profile');
  assert.ok(SANDBOX_PROFILES['sandbox-exec'], 'Must have sandbox-exec profile');
});

test('unsupported sandbox type throws', () => {
  assert.throws(
    () => buildSandboxedArgs('nonexistent-sandbox', '/tmp/clone', ['node', 'test.mjs']),
    /unsupported.*sandbox/i
  );
});

test('seatbeltWrap escapes quotes and backslashes in paths', () => {
  const dangerousDir = '/tmp/test"dir\\with\\slash';
  const sbpl = seatbeltWrap(dangerousDir);

  // Must escape " as \" and \ as \\
  assert.ok(sbpl.includes('(subpath "/tmp/test\\"dir\\\\with\\\\slash")'));
  assert.equal(seatbeltWrap, buildMacOSSbpl, 'seatbeltWrap should be an alias of buildMacOSSbpl');
});

test('escapeSeatbeltPath escapes backslashes and double quotes', () => {
  assert.equal(escapeSeatbeltPath('simple/path'), 'simple/path');
  assert.equal(escapeSeatbeltPath('path"with"quotes'), 'path\\"with\\"quotes');
  assert.equal(escapeSeatbeltPath('path\\with\\backslashes'), 'path\\\\with\\\\backslashes');
  assert.equal(escapeSeatbeltPath('mix"\\quote\\and"slash'), 'mix\\"\\\\quote\\\\and\\"slash');
});

test('buildSandboxedArgs with sandbox-exec escapes quotes and backslashes in cloneDir', () => {
  const cloneDir = '/tmp/dir"with\\special';
  const args = buildSandboxedArgs('sandbox-exec', cloneDir, ['node', 'test.mjs']);
  const pIdx = args.indexOf('-p');
  assert.ok(pIdx !== -1);
  const sbpl = args[pIdx + 1];
  assert.ok(sbpl.includes('/tmp/dir\\"with\\\\special'));
});


test('sanitizeCandidateEnv strips ADLC_*, API keys, tokens, secrets, passwords, and cloud creds while keeping benign env (#648)', () => {
  const raw = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    NODE_OPTIONS: '--no-warnings',
    UNDEFINED_VAR: undefined,
    ADLC_MANIFEST_KEY: 'top-secret-manifest-key',
    ADLC_RAILS_BYPASS: '1',
    adlc_lowercase: 'still-stripped',
    ANTHROPIC_API_KEY: 'sk-ant-123',
    OPENAI_API_KEY: 'sk-proj-123',
    GEMINI_API_KEY: 'AIza-123',
    CUSTOM_KEY: 'k1',
    MY_SECRET: 's1',
    TOPSECRET: 's2',
    AUTH_TOKEN: 't1',
     IDTOKEN: 't2',
    DB_PASSWORD_HASH: 'p1',
    AWS_SECRET_ACCESS_KEY: 'aws1',
    AWS_REGION: 'us-east-1',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json',
    GCP_PROJECT: 'p',
    AZURE_CLIENT_ID: 'az',
    GH_HOST: 'github.com',
    GITHUB_TOKEN: 'ghp_123',
    SERVICE_CREDENTIAL_PATH: '/etc/cred',
    NPM_TOKEN: 'npm_123',
  };

  const scrubbed = sanitizeCandidateEnv(raw);
  assert.deepEqual(scrubbed, {
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    NODE_OPTIONS: '--no-warnings',
  });
  assert.equal('UNDEFINED_VAR' in scrubbed, false);
  // Original object must not be mutated
  assert.equal(raw.ADLC_MANIFEST_KEY, 'top-secret-manifest-key');
});

test('spawnSandboxed scrubs ambient secrets by default and honors an explicit env override (#648)', () => {
  const prevManifest = process.env.ADLC_MANIFEST_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevBenign = process.env.GF_TEST_BENIGN_VAR;
  process.env.ADLC_MANIFEST_KEY = 'ambient-manifest-secret';
  process.env.ANTHROPIC_API_KEY = 'ambient-anthropic-secret';
  process.env.GF_TEST_BENIGN_VAR = 'keep-me';

  try {
    let capturedOpts = null;
    const res = spawnSandboxed('bwrap', '/tmp/clone', ['node', '-v'], {
      spawn: (_bin, _args, opts) => {
        capturedOpts = opts;
        return { status: 0, stdout: 'v24.0.0\n', stderr: '', signal: null };
      },
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, 'v24.0.0\n');
    assert.equal(res.timedOut, false);
    assert.ok(capturedOpts && capturedOpts.env, 'spawn must receive an env object');
    assert.equal(capturedOpts.env.ADLC_MANIFEST_KEY, undefined);
    assert.equal(capturedOpts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(capturedOpts.env.GF_TEST_BENIGN_VAR, 'keep-me');

    // Explicit env override is preserved
    let explicitCaptured = null;
    spawnSandboxed('bwrap', '/tmp/clone', ['node', '-v'], {
      env: { CUSTOM_ONLY: 'yes' },
      spawn: (_bin, _args, opts) => {
        explicitCaptured = opts;
        return { status: 0, stdout: '', stderr: '', signal: null };
      },
    });
    assert.deepEqual(explicitCaptured.env, { CUSTOM_ONLY: 'yes' });
  } finally {
    if (prevManifest === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = prevManifest;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevBenign === undefined) delete process.env.GF_TEST_BENIGN_VAR;
    else process.env.GF_TEST_BENIGN_VAR = prevBenign;
  }
});

test('spawnCandidateCmd (--unsafe-no-sandbox) does not leak ADLC_MANIFEST_KEY or provider keys to child process (#648)', () => {
  const prevManifest = process.env.ADLC_MANIFEST_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevBenign = process.env.GF_TEST_BENIGN_SUBPROC;
  process.env.ADLC_MANIFEST_KEY = 'unsafe-branch-manifest-secret';
  process.env.ANTHROPIC_API_KEY = 'unsafe-branch-anthropic-secret';
  process.env.GF_TEST_BENIGN_SUBPROC = 'benign-survives';

  try {
    const res = spawnCandidateCmd(
      [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({ m: process.env.ADLC_MANIFEST_KEY ?? null, a: process.env.ANTHROPIC_API_KEY ?? null, b: process.env.GF_TEST_BENIGN_SUBPROC ?? null }))',
      ],
      '/tmp',
      { sandboxType: null, unsafeNoSandbox: true },
    );
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout);
    assert.deepEqual(parsed, { m: null, a: null, b: 'benign-survives' });
  } finally {
    if (prevManifest === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = prevManifest;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevBenign === undefined) delete process.env.GF_TEST_BENIGN_SUBPROC;
    else process.env.GF_TEST_BENIGN_SUBPROC = prevBenign;
  }
});
