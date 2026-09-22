import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, gitRepo, runBin, DEFAULT_SCRUBBED_ENV, GIT_SCRUBBED_ENV } from '../lib/test-kit.mjs';

test('tmp: creates temp directory with default prefix and returns real path', () => {
  const dir = tmp(null);
  try {
    assert.ok(existsSync(dir), 'temp directory must exist on disk');
    assert.match(dir, /adlc-test-/, 'default prefix should be adlc-test-');
  } finally {
    // manual cleanup since no t was passed
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tmp: uses custom prefix when provided', () => {
  const dir = tmp(null, 'custom-prefix-');
  try {
    assert.ok(existsSync(dir));
    assert.match(dir, /custom-prefix-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tmp: registers cleanup via t.after when available', (t) => {
  let afterCallback = null;
  const mockContext = {
    after(fn) {
      afterCallback = fn;
    },
  };

  const dir = tmp(mockContext, 'adlc-after-test-');
  assert.ok(existsSync(dir), 'directory should exist before after hook runs');
  assert.equal(typeof afterCallback, 'function', 't.after must be registered');

  // Invoke after hook
  afterCallback();
  assert.ok(!existsSync(dir), 'directory must not exist after t.after callback runs');
});

test('tmp: automatically cleans up after test finishes (AC3)', async (t) => {
  let subtestDir;
  await t.test('isolated subtest for tmp lifecycle', (subT) => {
    subtestDir = tmp(subT, 'adlc-subtest-tmp-');
    assert.ok(existsSync(subtestDir), 'subtest directory must exist during test execution');
  });

  // Once subtest finishes, subT.after must have fired and removed the directory
  assert.ok(!existsSync(subtestDir), 'subtest directory must be removed after test completes');
});

test('gitRepo: creates repo, configures credentials and gpgsign false', (t) => {
  const repo = gitRepo(t, { prefix: 'adlc-test-repo-' });
  assert.ok(existsSync(repo.dir), 'repo directory must exist');
  assert.match(repo.dir, /adlc-test-repo-/);

  // Check git config
  const email = repo.git('config', 'user.email').trim();
  const name = repo.git('config', 'user.name').trim();
  const gpgSign = repo.git('config', 'commit.gpgsign').trim();

  assert.ok(email.length > 0, 'user.email must be configured');
  assert.ok(name.length > 0, 'user.name must be configured');
  assert.equal(gpgSign, 'false', 'commit.gpgsign must be explicitly false');
});

test('gitRepo: commits can be made without gpg signing failure', (t) => {
  const { dir, git, g } = gitRepo(t);
  assert.equal(typeof git, 'function');
  assert.equal(git, g, 'g must alias git');

  writeFileSync(join(dir, 'sample.txt'), 'hello world\n', 'utf8');
  git('add', 'sample.txt');
  // Commit should succeed without GPG errors or missing user identity
  git('commit', '-m', 'test commit');

  const log = git('log', '-1', '--oneline').trim();
  assert.match(log, /test commit/);

  // Array arguments format should also work
  const status = git(['status', '--porcelain']).trim();
  assert.equal(status, '', 'tree should be clean after commit');
});

test('gitRepo: respects custom options for branch and credentials', (t) => {
  const repo = gitRepo(t, {
    branch: 'trunk',
    userEmail: 'custom@adlc.dev',
    userName: 'Custom Tester',
  });

  const branch = repo.git('branch', '--show-current').trim();
  assert.equal(branch, 'trunk', 'initial branch should match custom option');

  const email = repo.git('config', 'user.email').trim();
  const name = repo.git('config', 'user.name').trim();
  assert.equal(email, 'custom@adlc.dev');
  assert.equal(name, 'Custom Tester');
});

test('runBin: runs a node binary with scrubbed environment', (t) => {
  const dir = tmp(t, 'adlc-runbin-');
  const probeScript = join(dir, 'probe.mjs');

  // Script that dumps queried environment variables as JSON
  writeFileSync(probeScript, `
    const vars = {
      ADLC_MANIFEST_KEY: process.env.ADLC_MANIFEST_KEY || null,
      ADLC_ADMIN_KEY: process.env.ADLC_ADMIN_KEY ?? null,
      ADLC_RAILS_BYPASS: process.env.ADLC_RAILS_BYPASS ?? null,
      ADLC_BUILD_GATE_BYPASS: process.env.ADLC_BUILD_GATE_BYPASS ?? null,
      ADLC_ALLOW_ADVISORY_HOOKS: process.env.ADLC_ALLOW_ADVISORY_HOOKS ?? null,
      RAILS_BASE: process.env.RAILS_BASE ?? null,
      BASE_REF: process.env.BASE_REF ?? null,
      ADLC_GATE_MOCK_RESPONSE: process.env.ADLC_GATE_MOCK_RESPONSE ?? null,
      CUSTOM_SAFE_VAR: process.env.CUSTOM_SAFE_VAR ?? null,
    };
    process.stdout.write(JSON.stringify(vars));
  `);

  // Set ambient env in parent process
  const prevKey = process.env.ADLC_MANIFEST_KEY;
  const prevAdmin = process.env.ADLC_ADMIN_KEY;
  const prevBypass = process.env.ADLC_RAILS_BYPASS;
  process.env.ADLC_MANIFEST_KEY = 'ambient-secret-key';
  process.env.ADLC_ADMIN_KEY = 'ambient-admin-key';
  process.env.ADLC_RAILS_BYPASS = '1';

  try {
    // 1. By default: ADLC_MANIFEST_KEY, ADLC_ADMIN_KEY and bypass flags are scrubbed
    const result = runBin(probeScript, [], {
      env: { CUSTOM_SAFE_VAR: 'preserved' },
    });
    assert.equal(result.status, 0);

    const received = JSON.parse(result.stdout);
    assert.equal(received.ADLC_MANIFEST_KEY, null, 'ADLC_MANIFEST_KEY must be scrubbed by default');
    assert.equal(received.ADLC_ADMIN_KEY, null, 'ADLC_ADMIN_KEY must be scrubbed by default');
    assert.equal(received.ADLC_RAILS_BYPASS, null, 'ADLC_RAILS_BYPASS must be scrubbed by default');
    assert.equal(received.CUSTOM_SAFE_VAR, 'preserved', 'Safe variable must be passed through');

    // 2. Explicitly allowed key in options.env with allowKey is passed through
    const withExplicitKey = runBin(probeScript, [], {
      env: { ADLC_MANIFEST_KEY: 'explicit-allowed-key' },
      allowKey: true,
    });
    assert.equal(withExplicitKey.status, 0);
    const receivedExplicit = JSON.parse(withExplicitKey.stdout);
    assert.equal(receivedExplicit.ADLC_MANIFEST_KEY, 'explicit-allowed-key');

    // 2b. Forwarded bypass in options.env without explicit allow option is scrubbed
    const withForwardedBypass = runBin(probeScript, [], {
      env: { ADLC_RAILS_BYPASS: '1', CUSTOM_SAFE_VAR: 'preserved' },
    });
    assert.equal(withForwardedBypass.status, 0);
    const receivedForwarded = JSON.parse(withForwardedBypass.stdout);
    assert.equal(receivedForwarded.ADLC_RAILS_BYPASS, null, 'forwarded bypass in options.env must be scrubbed by default');
    assert.equal(receivedForwarded.CUSTOM_SAFE_VAR, 'preserved');

    // 3. Explicitly allowed key via allowKey option is passed through from ambient env
    const withAllowKey = runBin(probeScript, [], { allowKey: true });
    assert.equal(withAllowKey.status, 0);
    const receivedAllow = JSON.parse(withAllowKey.stdout);
    assert.equal(receivedAllow.ADLC_MANIFEST_KEY, 'ambient-secret-key');

    // 4. allowEnv array option
    const withAllowEnv = runBin(probeScript, [], { allowEnv: ['ADLC_RAILS_BYPASS'] });
    assert.equal(withAllowEnv.status, 0);
    const receivedAllowEnv = JSON.parse(withAllowEnv.stdout);
    assert.equal(receivedAllowEnv.ADLC_RAILS_BYPASS, '1');
    assert.equal(receivedAllowEnv.ADLC_MANIFEST_KEY, null);
  } finally {
    if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = prevKey;
    if (prevAdmin === undefined) delete process.env.ADLC_ADMIN_KEY;
    else process.env.ADLC_ADMIN_KEY = prevAdmin;
    if (prevBypass === undefined) delete process.env.ADLC_RAILS_BYPASS;
    else process.env.ADLC_RAILS_BYPASS = prevBypass;
  }
});

test('runBin: captures args, status, stdout, stderr, and cwd', (t) => {
  const dir = tmp(t, 'adlc-runbin-cwd-');
  const script = join(dir, 'echo.mjs');
  writeFileSync(script, `
    const [arg1, arg2] = process.argv.slice(2);
    process.stdout.write('OUT:' + arg1 + ',' + arg2 + ' CWD:' + process.cwd());
    process.stderr.write('ERR:warning');
    process.exit(0);
  `);

  const result = runBin(script, ['foo', 'bar'], { cwd: dir });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OUT:foo,bar/);
  assert.match(result.stdout, new RegExp('CWD:' + dir));
  assert.equal(result.stderr, 'ERR:warning');
});

test('DEFAULT_SCRUBBED_ENV contains all required sensitive variables and is frozen', () => {
  assert.ok(Array.isArray(DEFAULT_SCRUBBED_ENV));
  assert.ok(Object.isFrozen(DEFAULT_SCRUBBED_ENV), 'DEFAULT_SCRUBBED_ENV must be frozen against runtime tampering');
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('ADLC_MANIFEST_KEY'));
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('ADLC_ADMIN_KEY'));
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('ADLC_RAILS_BYPASS'));
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('ADLC_BUILD_GATE_BYPASS'));
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('ADLC_ALLOW_ADVISORY_HOOKS'));
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('RAILS_BASE'));
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('BASE_REF'));
  assert.ok(DEFAULT_SCRUBBED_ENV.includes('ADLC_GATE_MOCK_RESPONSE'));
});

test('gitRepo: accepts options as first argument without test context', () => {
  const repo = gitRepo({ prefix: 'adlc-no-ctx-' });
  try {
    assert.ok(existsSync(repo.dir));
    assert.match(repo.dir, /adlc-no-ctx-/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('gitRepo: accepts string prefix as first or second argument', (t) => {
  const repo1 = gitRepo('adlc-string-pref-');
  try {
    assert.match(repo1.dir, /adlc-string-pref-/);
  } finally {
    rmSync(repo1.dir, { recursive: true, force: true });
  }

  const repo2 = gitRepo(t, 'adlc-t-string-pref-');
  assert.match(repo2.dir, /adlc-t-string-pref-/);
});

test('tmp: accepts string prefix as first argument without test context', () => {
  const dir = tmp('adlc-tmp-pref-');
  try {
    assert.match(dir, /adlc-tmp-pref-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitRepo: captures stderr on command failure', (t) => {
  const { git } = gitRepo(t);
  assert.throws(
    () => git('checkout', 'definitely-nonexistent-branch-name'),
    (err) => {
      assert.ok(typeof err.stderr === 'string', 'stderr must be returned as string');
      assert.ok(err.stderr.length > 0, 'stderr must not be empty');
      return true;
    }
  );
});

test('gitRepo: git accepts options when passed array arguments', (t) => {
  const { git } = gitRepo(t);
  assert.throws(
    () => git(['config', '--list'], { maxBuffer: 1 }),
    /ENOBUFS/
  );
});

test('gitRepo: git accepts options as trailing argument with varargs', (t) => {
  const { git } = gitRepo(t);
  assert.throws(
    () => git('config', '--list', { maxBuffer: 1 }),
    /ENOBUFS/
  );
  assert.throws(
    () => git('status', { maxBuffer: 1 }),
    /ENOBUFS/
  );
});

test('runBin: accepts options as second argument omitting args array', (t) => {
  const dir = tmp(t, 'adlc-runbin-opt-');
  const script = join(dir, 'test-cwd.mjs');
  writeFileSync(script, 'process.stdout.write(process.cwd());');
  const res = runBin(script, { cwd: dir });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, dir);
});

test('runBin: win32 scrubs environment variables case-insensitively', (t) => {
  const dir = tmp(t, 'adlc-runbin-win-');
  const script = join(dir, 'probe-win.mjs');
  writeFileSync(script, `
    const vars = {
      manifestLower: process.env.adlc_manifest_key || null,
      bypassMixed: process.env.Adlc_Rails_Bypass ?? null,
    };
    process.stdout.write(JSON.stringify(vars));
  `);

  process.env.adlc_manifest_key = 'lower-secret';
  process.env.Adlc_Rails_Bypass = '1';

  try {
    const res = runBin(script, [], { platform: 'win32' });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.manifestLower, null, 'win32 should scrub lowercase adlc_manifest_key');
    assert.equal(parsed.bypassMixed, null, 'win32 should scrub mixed-case Adlc_Rails_Bypass');
  } finally {
    delete process.env.adlc_manifest_key;
    delete process.env.Adlc_Rails_Bypass;
  }
});

test('GIT_SCRUBBED_ENV contains all required git redirection variables and is frozen', () => {
  assert.ok(Array.isArray(GIT_SCRUBBED_ENV));
  assert.ok(Object.isFrozen(GIT_SCRUBBED_ENV));
  assert.ok(GIT_SCRUBBED_ENV.includes('GIT_DIR'));
  assert.ok(GIT_SCRUBBED_ENV.includes('GIT_WORK_TREE'));
  assert.ok(GIT_SCRUBBED_ENV.includes('GIT_INDEX_FILE'));
  assert.ok(GIT_SCRUBBED_ENV.includes('GIT_OBJECT_DIRECTORY'));
  assert.ok(GIT_SCRUBBED_ENV.includes('GIT_COMMON_DIR'));
  assert.ok(GIT_SCRUBBED_ENV.includes('GIT_PREFIX'));
});

test('gitRepo: ambient GIT_DIR and GIT_WORK_TREE do not redirect repository operations', (t) => {
  const decoyDir = tmp(t, 'adlc-decoy-repo-');
  const decoyGit = join(decoyDir, '.git');

  const prevGitDir = process.env.GIT_DIR;
  const prevGitWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = decoyGit;
  process.env.GIT_WORK_TREE = decoyDir;

  try {
    const repo = gitRepo(t, 'adlc-isolated-');
    writeFileSync(join(repo.dir, 'committed.txt'), 'isolated content\n');
    repo.git('add', 'committed.txt');
    repo.git('commit', '-m', 'isolated commit');

    assert.ok(!existsSync(decoyGit), 'decoy git directory must not be created or touched');
    assert.ok(existsSync(join(repo.dir, '.git')), 'isolated repo .git must exist in repo.dir');
  } finally {
    if (prevGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prevGitDir;
    if (prevGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = prevGitWorkTree;
  }
});

test('runBin: default scrub blocks .env.local fallback for ADLC_MANIFEST_KEY', (t) => {
  const dir = tmp(t, 'adlc-env-local-');
  writeFileSync(join(dir, '.env.local'), 'ADLC_MANIFEST_KEY=leaked-from-env-local\n');
  const loaderUrl = new URL('../../prosecute/lib/load-env-local.mjs', import.meta.url).href;
  const probeScript = join(dir, 'probe-env.mjs');
  writeFileSync(probeScript, `
    import { loadManifestKeyFromEnvLocal } from '${loaderUrl}';
    loadManifestKeyFromEnvLocal({ cwd: process.cwd(), env: process.env });
    process.stdout.write(process.env.ADLC_MANIFEST_KEY || 'no-key');
  `);

  const result = runBin(probeScript, [], { cwd: dir });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'no-key', 'runBin default scrub must block .env.local fallback');
});

test('gitRepo: per-call cwd and env overrides cannot redirect repository operations', (t) => {
  const repo = gitRepo(t);
  const decoyDir = tmp(t, 'adlc-decoy-');

  // Attempt to redirect cwd via call options
  const rev = repo.git(['rev-parse', '--show-toplevel'], { cwd: decoyDir }).trim();
  assert.equal(rev, repo.dir, 'gitRepo must enforce cwd: dir even when callOpts specifies cwd');

  // Attempt to redirect GIT_DIR via call options env
  const decoyGit = join(decoyDir, '.git');
  repo.git(['status'], { env: { GIT_DIR: decoyGit } });
  assert.ok(!existsSync(decoyGit), 'callOpts.env GIT_DIR must not redirect repository');
});




