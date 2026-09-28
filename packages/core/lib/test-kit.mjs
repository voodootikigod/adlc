import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const DEFAULT_SCRUBBED_ENV = Object.freeze([
  'ADLC_MANIFEST_KEY',
  'ADLC_ADMIN_KEY',
  'ADLC_RAILS_BYPASS',
  'ADLC_BUILD_GATE_BYPASS',
  'ADLC_ALLOW_ADVISORY_HOOKS',
  'RAILS_BASE',
  'BASE_REF',
  'ADLC_GATE_MOCK_RESPONSE',
]);

export const GIT_SCRUBBED_ENV = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]);

/** Options every kit fixture is removed with: transient ENOTEMPTY/EBUSY races are retried, not fatal. */
export const FIXTURE_RM_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

function requireContext(fnName, t) {
  if (typeof t?.after !== 'function') {
    throw new TypeError(
      `${fnName}() requires a test context with an .after(fn) hook as its first argument ` +
      '(the `t` of test()/it()/beforeEach()); describe-level before()/after() hooks receive a context ' +
      'without .after. Outside a test, wrap the work in withScopedContext(async (ctx) => ...).',
    );
  }
}

/**
 * Creates a unique temporary directory whose removal is registered on t.after().
 * Throws a TypeError, creating nothing, when t has no callable .after: a fixture
 * is never minted without the hook that removes it.
 *
 * @param {{ after: (fn: () => void) => void }} t Test context
 * @param {string} [prefix='adlc-test-'] Prefix for mkdtempSync
 * @returns {string} Realpath of the newly created temp directory
 */
export function tmp(t, prefix = 'adlc-test-') {
  requireContext('tmp', t);
  // Register before minting: a context that refuses the hook leaves nothing behind.
  let dir = null;
  t.after(() => { if (dir !== null) rmSync(dir, FIXTURE_RM_OPTIONS); });
  dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return dir;
}

/**
 * A context for fixtures whose lifetime is not one node:test callback, such as
 * a describe block (create in before(), dispose in after()). Its .after hooks
 * run when dispose() is called, last registered first; every hook runs even if
 * one throws, and the first failure is rethrown. Registering after dispose()
 * throws, so a late tmp() cannot mint a directory nothing will remove.
 *
 * @returns {Readonly<{ after: (fn: () => unknown) => void, dispose: () => Promise<void> }>}
 */
export function createScope() {
  const hooks = [];
  let disposed = false;
  return Object.freeze({
    after(hook) {
      if (disposed) throw new Error('createScope(): this scope is already disposed');
      hooks.push(hook);
    },
    async dispose() {
      disposed = true;
      const errors = [];
      for (const hook of hooks.splice(0).reverse()) {
        try { await hook(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw errors[0];
    },
  });
}

/**
 * Runs fn(ctx) with a createScope() context that is disposed once fn settles.
 * For code that needs kit fixtures outside a node:test callback (e.g. a gate
 * that invokes exported test functions directly). fn's own error wins over a
 * cleanup error; otherwise a cleanup error is rethrown.
 *
 * @template T
 * @param {(ctx: { after: (fn: () => unknown) => void }) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withScopedContext(fn) {
  if (typeof fn !== 'function') throw new TypeError('withScopedContext() requires a function');
  const scope = createScope();
  let outcome;
  try {
    outcome = { value: await fn(scope) };
  } catch (error) {
    outcome = { error };
  }
  try {
    await scope.dispose();
  } catch (cleanupError) {
    if (!('error' in outcome)) throw cleanupError;
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/**
 * Creates an isolated git repository within a tmp(t) directory.
 * Configures user.email and user.name, disables commit.gpgsign, and disables
 * automatic gc (gc.auto=0, gc.autoDetach=false) so no detached maintenance
 * child can still be writing into .git while the fixture is removed.
 * Throws, creating nothing, when t has no callable .after (see tmp()).
 *
 * @param {{ after: (fn: () => void) => void }} t Test context
 * @param {object|string} [options={}] Repository options, or a prefix string
 * @returns {{ dir: string, git: Function, g: Function }}
 */
export function gitRepo(t, options = {}) {
  requireContext('gitRepo', t);
  const opts = typeof options === 'string' ? { prefix: options } : (options ?? {});

  const prefix = opts.prefix || 'adlc-repo-';
  const branch = opts.branch || 'main';
  const email = opts.userEmail || opts.email || 'test@adlc.local';
  const name = opts.userName || opts.name || 'tester';

  const dir = tmp(t, prefix);

  const git = (...args) => {
    let callArgs;
    let callOpts = {};
    if (Array.isArray(args[0])) {
      callArgs = args[0];
      if (args[1] && typeof args[1] === 'object') {
        callOpts = args[1];
      }
    } else {
      if (args.length > 0 && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1])) {
        callOpts = args[args.length - 1];
        callArgs = args.slice(0, -1);
      } else {
        callArgs = args;
      }
    }

    const env = { ...process.env, ...callOpts.env };
    for (const varName of GIT_SCRUBBED_ENV) {
      delete env[varName];
      if (process.platform === 'win32') {
        const lower = varName.toLowerCase();
        for (const key of Object.keys(env)) {
          if (key.toLowerCase() === lower) {
            delete env[key];
          }
        }
      }
    }

    return execFileSync('git', callArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...callOpts,
      cwd: dir,
      env,
    });
  };

  git('init', '-q', '-b', branch);
  git('config', 'user.email', email);
  git('config', 'user.name', name);
  git('config', 'commit.gpgsign', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'gc.autoDetach', 'false');

  return { dir, git, g: git };
}

/**
 * Runs a Node binary with sanitized environment variables.
 * Scrubbing removes ADLC_MANIFEST_KEY, bypass flags, etc. unless explicitly allowed.
 *
 * @param {string} binPath Path to node script / binary
 * @param {string[]|object} [args=[]] Command line arguments or options if no args
 * @param {object} [options={}] Spawn options
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function runBin(binPath, args = [], options = {}) {
  let callArgs = args;
  let callOpts = options;
  if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
    callOpts = args;
    callArgs = [];
  }

  const env = { ...process.env };
  if (callOpts.env) {
    Object.assign(env, callOpts.env);
  }

  const allowed = new Set(
    Array.isArray(callOpts.allowEnv)
      ? callOpts.allowEnv
      : Array.isArray(callOpts.allowKeys)
        ? callOpts.allowKeys
        : callOpts.allowKey
          ? ['ADLC_MANIFEST_KEY']
          : []
  );

  const isWin32 = (callOpts.platform ?? process.platform) === 'win32';
  for (const varName of DEFAULT_SCRUBBED_ENV) {
    if (!allowed.has(varName)) {
      if (isWin32) {
        for (const key of Object.keys(env)) {
          if (key.toUpperCase() === varName) {
            delete env[key];
          }
        }
      } else {
        delete env[varName];
      }
      if (varName === 'ADLC_MANIFEST_KEY') {
        env.ADLC_MANIFEST_KEY = '';
      }
    }
  }

  const spawnOpts = {
    encoding: 'utf8',
    ...callOpts,
    env,
  };
  delete spawnOpts.allowEnv;
  delete spawnOpts.allowKeys;
  delete spawnOpts.allowKey;
  delete spawnOpts.platform;

  return spawnSync(process.execPath, [binPath, ...callArgs], spawnOpts);
}
