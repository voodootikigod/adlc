// §1.7 — sandbox profiles, allowlist, no-sandbox refuse (F6)
// These tests operate on the sandbox module logic without actually spawning
// a bwrap/sandbox-exec process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  collectMaskedEnvFiles,
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

test('buildSandboxedArgs (bwrap) masks host .env/.env.local files and sensitive $HOME stores after --ro-bind / /', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gf-sb-mask-'));
  try {
    const repoRoot = join(scratch, 'repo');
    const nestedWorktree = join(repoRoot, '.worktrees', 'lane');
    const cloneDir = join(scratch, 'clone');
    const fakeHome = join(scratch, 'home');
    mkdirSync(nestedWorktree, { recursive: true });
    mkdirSync(cloneDir, { recursive: true });
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true });
    writeFileSync(join(fakeHome, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
    writeFileSync(join(repoRoot, '.env.local'), 'ADLC_MANIFEST_KEY=super-secret\n');
    writeFileSync(join(nestedWorktree, '.env'), 'LOCAL_SECRET=1\n');
    writeFileSync(join(cloneDir, '.env.test'), 'CLONE_FIXTURE=1\n');

    const realEnvLocal = realpathSync(join(repoRoot, '.env.local'));
    const realNestedEnv = realpathSync(join(nestedWorktree, '.env'));
    const realSsh = realpathSync(join(fakeHome, '.ssh'));
    const realGh = realpathSync(join(fakeHome, '.config', 'gh'));
    const realNpmrc = realpathSync(join(fakeHome, '.npmrc'));

    const maskedEnv = collectMaskedEnvFiles([nestedWorktree], cloneDir);
    assert.ok(maskedEnv.includes(realEnvLocal), 'ancestor .env.local must be discovered');
    assert.ok(maskedEnv.includes(realNestedEnv), 'workDir .env must be discovered');
    assert.ok(!maskedEnv.some((p) => p.includes('clone')), 'cloneDir .env.test must not be masked');

    const argv = buildSandboxedArgs('bwrap', cloneDir, ['node', 'check.mjs'], {
      workDir: nestedWorktree,
      cwd: nestedWorktree,
      homeDir: fakeHome,
    });
    const rootBindIdx = argv.findIndex((a, i) => a === '--ro-bind' && argv[i + 1] === '/' && argv[i + 2] === '/');
    const cloneBindIdx = argv.findIndex((a, i) => a === '--bind' && argv[i + 1] === cloneDir);
    const envMaskIdx = argv.findIndex((a, i) => a === '--ro-bind' && argv[i + 1] === '/dev/null' && argv[i + 2] === realEnvLocal);
    const sshMaskIdx = argv.findIndex((a, i) => a === '--tmpfs' && argv[i + 1] === realSsh);
    const ghMaskIdx = argv.findIndex((a, i) => a === '--tmpfs' && argv[i + 1] === realGh);
    const npmrcMaskIdx = argv.findIndex((a, i) => a === '--ro-bind' && argv[i + 1] === '/dev/null' && argv[i + 2] === realNpmrc);

    assert.ok(rootBindIdx !== -1);
    assert.ok(envMaskIdx > rootBindIdx && envMaskIdx < cloneBindIdx, '.env.local mask must layer after / and before cloneDir');
    assert.ok(sshMaskIdx > rootBindIdx, '~/.ssh must be masked with tmpfs');
    assert.ok(ghMaskIdx > rootBindIdx, '~/.config/gh must be masked with tmpfs');
    assert.ok(npmrcMaskIdx > rootBindIdx, '~/.npmrc must be masked with /dev/null');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('buildMacOSSbpl denies reading host .env* and sensitive $HOME paths while re-allowing cloneDir', () => {
  const sbpl = buildMacOSSbpl('/tmp/gf-clone', { homeDir: '/Users/alice' });
  const allowAllIdx = sbpl.indexOf('(allow file-read*)');
  const denyEnvIdx = sbpl.indexOf('(deny file-read* (regex #"(^|/)\\.env(\\..+)?$"))');
  const denySshIdx = sbpl.indexOf('(deny file-read* (subpath "/Users/alice/.ssh"))');
  const denyClaudeIdx = sbpl.indexOf('(deny file-read* (subpath "/Users/alice/.claude"))');
  const denyCodexIdx = sbpl.indexOf('(deny file-read* (subpath "/Users/alice/.codex"))');
  const denyGeminiIdx = sbpl.indexOf('(deny file-read* (subpath "/Users/alice/.gemini"))');
  const denyNpmrcIdx = sbpl.indexOf('(deny file-read* (literal "/Users/alice/.npmrc"))');
  const reallowCloneIdx = sbpl.indexOf('(allow file-read* (subpath "/tmp/gf-clone"))');

  assert.ok(allowAllIdx !== -1);
  assert.ok(denyEnvIdx > allowAllIdx, '.env* deny rule must come after blanket allow');
  assert.ok(denySshIdx > allowAllIdx, '~/.ssh deny rule must come after blanket allow');
  assert.ok(denyClaudeIdx > allowAllIdx && denyCodexIdx > allowAllIdx && denyGeminiIdx > allowAllIdx, 'agent CLI credential dirs must be denied');
  assert.ok(denyNpmrcIdx > allowAllIdx, '~/.npmrc deny rule must come after blanket allow');
  assert.ok(reallowCloneIdx > denyEnvIdx && reallowCloneIdx > denySshIdx, 'cloneDir read re-allow must come after host denies');

    // Control characters in homeDir, symlinked cloneDir targets, or sibling .worktrees MUST fail closed
    assert.throws(() => buildMacOSSbpl('/tmp/gf-clone', { homeDir: '/Users/alice\nevil' }), /Seatbelt path cannot contain NUL/);
    assert.throws(() => buildMacOSSbpl('/tmp/gf-clone', { homeDir: '/Users/alice\0evil' }), /Seatbelt path cannot contain NUL/);
    const ctrlScratch = mkdtempSync(join(tmpdir(), 'gf-sbpl-ctrl-'));
    try {
      const badTarget = join(ctrlScratch, 'real\ndir');
      const cleanLink = join(ctrlScratch, 'clean-clone');
      mkdirSync(badTarget, { recursive: true });
      symlinkSync(badTarget, cleanLink);
      assert.throws(() => buildMacOSSbpl(cleanLink, { homeDir: null }), /Seatbelt path cannot contain NUL/);

      const wtRepo = join(ctrlScratch, 'repo');
      const activeWt = join(wtRepo, '.worktrees', 'active-lane');
      const goodClone = join(ctrlScratch, 'good-clone');
      mkdirSync(activeWt, { recursive: true });
      mkdirSync(join(wtRepo, '.worktrees', 'bad\nlane'), { recursive: true });
      mkdirSync(goodClone, { recursive: true });
      assert.throws(() => buildMacOSSbpl(goodClone, { homeDir: null, workDir: activeWt, repoRoot: wtRepo }), /Seatbelt path cannot contain NUL/);
    } finally {
      rmSync(ctrlScratch, { recursive: true, force: true });
    }
});

test('buildSandboxedArgs masks repoRoot and $HOME .env.local even when cloneDir and cwd are in /tmp (real clone.mjs shape)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gf-real-clone-shape-'));
  try {
    const repoRoot = join(scratch, 'source-repo');
    const cloneDir = join(scratch, 'tmp-clone');
    const fakeHome = join(scratch, 'home');
    const dotfilesSsh = join(scratch, 'dotfiles', 'ssh');
    mkdirSync(join(repoRoot, 'packages', 'pkg-a'), { recursive: true });
    mkdirSync(cloneDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(dotfilesSsh, { recursive: true });
    symlinkSync(dotfilesSsh, join(fakeHome, '.ssh'));
    writeFileSync(join(repoRoot, '.env.local'), 'ADLC_MANIFEST_KEY=repo-secret\n');
    writeFileSync(join(repoRoot, 'packages', 'pkg-a', '.env.local'), 'SUBPKG_SECRET=sub-secret\n');
    writeFileSync(join(fakeHome, '.env.local'), 'OPENAI_API_KEY=home-secret\n');

    const realRepoEnv = realpathSync(join(repoRoot, '.env.local'));
    const realSubPkgEnv = realpathSync(join(repoRoot, 'packages', 'pkg-a', '.env.local'));
    const realHomeEnv = realpathSync(join(fakeHome, '.env.local'));
    const realDotfilesSsh = realpathSync(dotfilesSsh);

    // Mirrors clone.mjs: cwd === workDir === cloneDir (disjoint from repoRoot & homeDir)
    const argv = buildSandboxedArgs('bwrap', cloneDir, ['node', 'step.mjs'], {
      cwd: cloneDir,
      workDir: cloneDir,
      repoRoot,
      homeDir: fakeHome,
    });
    assert.ok(
      argv.some((a, i) => a === '--ro-bind' && argv[i + 1] === '/dev/null' && argv[i + 2] === realRepoEnv),
      'repoRoot/.env.local must be masked even when cwd === cloneDir in /tmp',
    );
    assert.ok(
      argv.some((a, i) => a === '--ro-bind' && argv[i + 1] === '/dev/null' && argv[i + 2] === realSubPkgEnv),
      'nested subdirectory packages/pkg-a/.env.local must also be masked',
    );
    assert.ok(
      argv.some((a, i) => a === '--ro-bind' && argv[i + 1] === '/dev/null' && argv[i + 2] === realHomeEnv),
      '$HOME/.env.local must be masked even when cwd === cloneDir in /tmp',
    );
    assert.ok(
      argv.some((a, i) => a === '--tmpfs' && argv[i + 1] === realDotfilesSsh),
      'symlinked ~/.ssh realpath target must be masked in bwrap',
    );

    // Seatbelt profile also denies symlinked .env.local whose target filename does not match .env*,
    // plus logical ~/.ssh, ~/.claude.json, and symlink target outside cloneDir
    const extSecretFile = join(scratch, 'vault', 'manifest-signing.key');
    mkdirSync(join(scratch, 'vault'), { recursive: true });
    writeFileSync(extSecretFile, 'ADLC_MANIFEST_KEY=symlinked-vault-secret\n');
    symlinkSync(extSecretFile, join(repoRoot, '.env.vault-link'));
    // Also plant a directory symlink inside repoRoot pointing outside (to fakeHome) — BFS must NOT escape into it
    symlinkSync(fakeHome, join(repoRoot, 'escape-link'));

    const sbpl = buildMacOSSbpl(cloneDir, { homeDir: fakeHome, repoRoot, workDir: repoRoot });
    assert.ok(sbpl.includes('(deny file-read* (subpath "/Users"))'), 'Seatbelt must deny /Users siblings by default');
    assert.ok(sbpl.includes('(deny file-read* (subpath "/private/tmp"))'), 'Seatbelt must deny /private/tmp siblings by default');
    assert.ok(sbpl.includes(`(allow file-read* (subpath "${repoRoot}"))`), 'Seatbelt re-allows non-clone workDir');
    assert.ok(sbpl.includes(`(deny file-read* (subpath "${fakeHome}"))`), 'Seatbelt must deny $HOME reads by default');
    assert.ok(sbpl.includes(`(allow file-read-metadata (subpath "${fakeHome}"))`), 'Seatbelt allows $HOME metadata stat/realpath');
    assert.ok(sbpl.includes(`(allow file-read* (subpath "${join(fakeHome, '.nvm')}"))`), 'Seatbelt re-allows read-only toolchain subpath');
    assert.ok(
      sbpl.indexOf(`(allow file-read* (subpath "${join(fakeHome, '.local')}"))`) <
      sbpl.indexOf(`(deny file-read* (subpath "${join(fakeHome, '.local/share/cursor-agent')}"))`),
      'sensitive ~/.local/share/cursor-agent deny must override ~/.local toolchain allow',
    );
    assert.ok(sbpl.includes(`(deny file-read* (literal "${realpathSync(extSecretFile)}"))`), 'Seatbelt must deny realpath target of symlinked .env*');
    assert.ok(sbpl.includes(`(deny file-read* (subpath "${join(fakeHome, '.ssh')}"))`));
    assert.ok(sbpl.includes(`(deny file-read* (literal "${join(fakeHome, '.claude.json')}"))`));
    assert.ok(sbpl.includes(`(deny file-read* (subpath "${join(fakeHome, '.local/share/cursor-agent')}"))`));
    assert.ok(sbpl.includes(`(deny file-read* (subpath "${realDotfilesSsh}"))`));

    const cloneDir2 = join(scratch, 'tmp-clone-2');
    mkdirSync(cloneDir2, { recursive: true });
    // Direct buildSandboxedArgs callers without envMaskCache ALSO reuse the default mtimeNs-keyed cache
    // when subdirectories grow without changing root mtimeNs, and refresh when root mtimeNs changes.
    const defaultCacheRoot = join(scratch, 'default-cache-root');
    const nestedHolder = join(defaultCacheRoot, 'holder');
    mkdirSync(nestedHolder, { recursive: true });
    writeFileSync(join(defaultCacheRoot, '.env.local'), 'DEFAULT_CACHED=1\n');
    const firstDefaultArgv = buildSandboxedArgs('bwrap', cloneDir, ['node', 'step.mjs'], {
      cwd: cloneDir, workDir: cloneDir, repoRoot: defaultCacheRoot, homeDir: fakeHome, maxEnvScanDirs: 3,
    });
    assert.ok(firstDefaultArgv.includes(realpathSync(join(defaultCacheRoot, '.env.local'))));
    // Grow grandchildren under nestedHolder (does NOT touch defaultCacheRoot's own mtimeNs): default cache hits!
    for (let i = 0; i < 6; i++) mkdirSync(join(nestedHolder, `deep-${i}`), { recursive: true });
    const secondDefaultArgv = buildSandboxedArgs('bwrap', cloneDir2, ['node', 'step.mjs'], {
      cwd: cloneDir2, workDir: cloneDir2, repoRoot: defaultCacheRoot, homeDir: fakeHome, maxEnvScanDirs: 3,
    });
    assert.ok(secondDefaultArgv.includes(realpathSync(join(defaultCacheRoot, '.env.local'))));
    // Run-scoped envMaskCache reuses a single host scan across distinct candidate cloneDirs,
    // and maxEnvScanDirs overrides the scan cap explicitly.
    const envMaskCache = new Map();
    buildSandboxedArgs('bwrap', cloneDir, ['node', 'step.mjs'], { repoRoot, homeDir: fakeHome, envMaskCache });
    assert.equal(envMaskCache.size, 1);
    const cachedArgv = buildSandboxedArgs('bwrap', cloneDir2, ['node', 'step.mjs'], { repoRoot, homeDir: fakeHome, envMaskCache });
    assert.equal(envMaskCache.size, 1, 'second candidate clone reuses cached host .env scan');
    assert.ok(cachedArgv.some((a, i) => a === '--ro-bind' && cachedArgv[i + 1] === '/dev/null' && cachedArgv[i + 2] === realRepoEnv));
    assert.throws(
      () => buildSandboxedArgs('bwrap', cloneDir, ['node', 'step.mjs'], { repoRoot, homeDir: fakeHome, maxEnvScanDirs: 1 }),
      /exceeded directory scan limit \(1\)/,
    );

    // collectMaskedEnvFiles fails closed if directory cap is exceeded instead of returning a partial mask
    assert.throws(
      () => collectMaskedEnvFiles([repoRoot], cloneDir, { maxDirs: 1 }),
      /exceeded directory scan limit/,
    );

    // Symlinked cloneDir and symlinked workDir bind both logical and canonical paths in bwrap
    const linkClone = join(scratch, 'symlink-to-clone');
    const linkRepo = join(scratch, 'symlink-to-repo');
    symlinkSync(cloneDir, linkClone);
    symlinkSync(repoRoot, linkRepo);
    const symArgv = buildSandboxedArgs('bwrap', linkClone, ['node', 'step.mjs'], {
      cwd: linkRepo,
      workDir: linkRepo,
      repoRoot: linkRepo,
      homeDir: fakeHome,
    });
    assert.ok(
      symArgv.some((a, i) => a === '--bind' && symArgv[i + 1] === linkClone && symArgv[i + 2] === linkClone),
      'logical symlink cloneDir bound',
    );
    assert.ok(
      symArgv.some((a, i) => a === '--bind' && symArgv[i + 1] === realpathSync(cloneDir) && symArgv[i + 2] === realpathSync(cloneDir)),
      'canonical realpath cloneDir also bound',
    );
    assert.ok(
      symArgv.some((a, i) => a === '--ro-bind' && symArgv[i + 1] === realpathSync(repoRoot) && symArgv[i + 2] === linkRepo),
      'logical symlink workDir rebound to canonical workReal so --chdir succeeds',
    );
    mkdirSync(join(repoRoot, '.worktrees', 'lane-sym'), { recursive: true });
    const linkWtLane = join(linkRepo, '.worktrees', 'lane-sym');
    const symWtArgv = buildSandboxedArgs('bwrap', linkClone, ['node', 'step.mjs'], {
      cwd: linkWtLane,
      workDir: linkWtLane,
      repoRoot: linkWtLane,
      homeDir: fakeHome,
    });
    assert.ok(
      symWtArgv.some((a, i) => a === '--ro-bind' && symArgv[i + 1] !== undefined && symWtArgv[i + 1] === realpathSync(linkWtLane) && symWtArgv[i + 2] === linkWtLane),
      'symlinked .worktrees/<lane> workDir is rebound so --chdir succeeds',
    );

    // Leading-dash cmdArgs[0] MUST be rejected, and sandbox-exec MUST emit '--' before cmdArgs
    assert.throws(() => buildSandboxedArgs('sandbox-exec', cloneDir, ['-p', 'evil']), /cmdArgs\[0\]/);
    assert.throws(() => buildSandboxedArgs('bwrap', cloneDir, ['-v']), /cmdArgs\[0\]/);
    const seArgs = buildSandboxedArgs('sandbox-exec', cloneDir, ['node', 'step.mjs'], { homeDir: fakeHome });
    const ddIdx = seArgs.indexOf('--');
    assert.ok(ddIdx > seArgs.indexOf('-p'), 'sandbox-exec must pass -- before command');
    assert.deepEqual(seArgs.slice(ddIdx + 1), ['node', 'step.mjs']);

    // Default MAX_ENV_SCAN_DIRS (16384) boundary: 16384 total directories succeeds, 16385 fails closed
    const makeVirtualFs = (totalDirs) => {
      const children = Array.from({ length: totalDirs - 1 }, (_, i) => ({
        name: `d${i}`,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }));
      const envEntry = [{ name: '.env', isDirectory: () => false, isSymbolicLink: () => false }];
      return {
        readdirSync: (d) => (d === '/vroot' ? children : d === '/vroot/d0' ? envEntry : []),
        realpathSync: (p) => {
          if (p === '/vroot' || p.startsWith('/vroot/') || p === '/vclone') return p;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        statSync: (p) => {
          if (p === '/vroot/d0/.env') return { isDirectory: () => false, isFile: () => true };
          if (p === '/vroot' || p.startsWith('/vroot/d')) return { isDirectory: () => true, isFile: () => false };
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      };
    };
    assert.deepEqual(collectMaskedEnvFiles(['/vroot'], '/vclone', { fsOps: makeVirtualFs(16384) }), ['/vroot/d0/.env']);
    assert.throws(
      () => collectMaskedEnvFiles(['/vroot'], '/vclone', { fsOps: makeVirtualFs(16385) }),
      /exceeded directory scan limit \(16384\)/,
    );
    const prevScanCap = process.env.ADLC_MAX_ENV_SCAN_DIRS;
    try {
      process.env.ADLC_MAX_ENV_SCAN_DIRS = '2';
      assert.throws(
        () => collectMaskedEnvFiles(['/vroot'], '/vclone', { fsOps: makeVirtualFs(3) }),
        /exceeded directory scan limit \(2\)/,
      );
      process.env.ADLC_MAX_ENV_SCAN_DIRS = '0';
      assert.deepEqual(collectMaskedEnvFiles(['/vroot'], '/vclone', { fsOps: makeVirtualFs(3) }), ['/vroot/d0/.env']);
    } finally {
      if (prevScanCap === undefined) delete process.env.ADLC_MAX_ENV_SCAN_DIRS;
      else process.env.ADLC_MAX_ENV_SCAN_DIRS = prevScanCap;
    }

    // If bwrap is installed on this Linux host, verify at runtime that sibling .worktrees and $HOME secrets are wiped!
    if (detectSandbox() === 'bwrap') {
      const primaryRepo = join(scratch, 'primary-repo');
      const activeLane = join(primaryRepo, '.worktrees', 'lane-a');
      const siblingLane = join(primaryRepo, '.worktrees', 'lane-b');
      mkdirSync(join(primaryRepo, '.git', 'worktrees', 'lane-a'), { recursive: true });
      mkdirSync(activeLane, { recursive: true });
      mkdirSync(siblingLane, { recursive: true });
      writeFileSync(join(activeLane, '.git'), `gitdir: ${join(primaryRepo, '.git', 'worktrees', 'lane-a')}\n`);
      writeFileSync(join(siblingLane, '.env.local'), 'ADLC_MANIFEST_KEY=sibling-worktree-secret\n');
      writeFileSync(join(fakeHome, 'unrelated-secret.txt'), 'HOME_ARBITRARY_SECRET\n');
      writeFileSync(join(cloneDir, 'allowed.txt'), 'CLONE_READABLE\n');

      const probeScript = [
        'const fs = require("node:fs");',
        `const sib = (() => { try { return fs.readFileSync(${JSON.stringify(join(siblingLane, '.env.local'))}, "utf8"); } catch (e) { return e.code; } })();`,
        `const homeSec = (() => { try { return fs.readFileSync(${JSON.stringify(join(fakeHome, 'unrelated-secret.txt'))}, "utf8"); } catch (e) { return e.code; } })();`,
        `const cloneOk = fs.readFileSync(${JSON.stringify(join(cloneDir, 'allowed.txt'))}, "utf8").trim();`,
        'process.stdout.write(JSON.stringify({ sib, homeSec, cloneOk }));',
      ].join(' ');
      const live = spawnSandboxed('bwrap', cloneDir, [process.execPath, '-e', probeScript], {
        cwd: cloneDir,
        repoRoot: activeLane,
        homeDir: fakeHome,
      });
      assert.equal(live.exitCode, 0, `bwrap live probe failed: ${live.stderr}`);
      const out = JSON.parse(live.stdout);
      assert.equal(out.cloneOk, 'CLONE_READABLE');
      assert.ok(
        out.sib === 'ENOENT' || out.sib === 'EACCES' || out.sib === '',
        `sibling worktree .env.local must not leak: ${out.sib}`,
      );
      assert.ok(!out.sib.includes('sibling-worktree-secret'));
      assert.ok(
        out.homeSec === 'ENOENT' || out.homeSec === 'EACCES',
        `arbitrary $HOME files outside toolchains must be wiped by tmpfs: ${out.homeSec}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('makeProvisionFn caches host .env scan across candidate clones within a run', async () => {
  const { execFileSync } = await import('node:child_process');
  const { makeProvisionFn } = await import('../lib/provision.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'gf-prov-cache-'));
  const origCwd = process.cwd();
  try {
    const provRepo = join(scratch, 'repo');
    mkdirSync(provRepo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: provRepo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], { cwd: provRepo });
    process.chdir(provRepo);

    const prov = makeProvisionFn({
      repoRoot: provRepo,
      sandboxType: 'sandbox-exec',
      suite: [],
      maxEnvScanDirs: 2,
    });
    const c1 = await prov({ diff: '', setup: [['echo', 'one']] });
    assert.equal(c1.error, undefined);
    c1.destroy();

    // Grow provRepo beyond maxEnvScanDirs (2): a second candidate within the SAME
    // makeProvisionFn run reuses the run-scoped envMaskCache instead of re-scanning.
    mkdirSync(join(provRepo, 'sub-a'), { recursive: true });
    mkdirSync(join(provRepo, 'sub-b'), { recursive: true });
    mkdirSync(join(provRepo, 'sub-c'), { recursive: true });
    const c2 = await prov({ diff: '', setup: [['echo', 'two']] });
    assert.equal(c2.error, undefined, `expected cached host scan to succeed, got: ${c2.error}`);
    c2.destroy();

    const { provisionClone, destroyClone } = await import('../lib/clone.mjs');
    let stepCount = 0;
    const direct = provisionClone(
      { diff: '', setup: [['node', '-v'], ['node', '-v']] },
      {
        repoRoot: provRepo,
        sandboxType: 'sandbox-exec',
        maxEnvScanDirs: 10,
        spawnFn: (bin, args, opts) => {
          if (bin === 'git') return { status: 0, stdout: '', stderr: '', signal: null };
          stepCount += 1;
          if (stepCount === 1) {
            for (let i = 0; i < 12; i++) mkdirSync(join(provRepo, `grow-${i}`), { recursive: true });
          }
          return { status: 0, stdout: '', stderr: '', signal: null };
        },
      },
    );
    assert.equal(direct.setupResults.length, 2);
    destroyClone(direct.cloneDir);
  } finally {
    process.chdir(origCwd);
    rmSync(scratch, { recursive: true, force: true });
  }
});
