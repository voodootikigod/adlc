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

/**
 * Creates a unique temporary directory and registers cleanup with t.after() if available.
 *
 * @param {object|string|null} [t] Test context with an .after(fn) hook, or prefix string if no context
 * @param {string} [prefix='adlc-test-'] Prefix for mkdtempSync
 * @returns {string} Realpath of the newly created temp directory
 */
export function tmp(t, prefix = 'adlc-test-') {
  let ctx = t;
  let dirPrefix = prefix;
  if (typeof t === 'string') {
    ctx = null;
    dirPrefix = t;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), dirPrefix)));
  if (typeof ctx?.after === 'function') {
    ctx.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  }
  return dir;
}

/**
 * Creates an isolated git repository within a tmp(t) directory.
 * Configures user.email, user.name, and disables commit.gpgsign.
 *
 * @param {object|string|null} [t] Test context or prefix
 * @param {object|string} [options={}] Repository configuration options
 * @returns {{ dir: string, git: Function, g: Function }}
 */
export function gitRepo(t, options = {}) {
  let ctx = t;
  let opts = options;
  if (t && typeof t.after !== 'function' && typeof t === 'object') {
    ctx = null;
    opts = t;
  } else if (typeof t === 'string') {
    ctx = null;
    opts = { prefix: t };
  } else if (typeof options === 'string') {
    opts = { prefix: options };
  }

  const prefix = opts.prefix || 'adlc-repo-';
  const branch = opts.branch || 'main';
  const email = opts.userEmail || opts.email || 'test@adlc.local';
  const name = opts.userName || opts.name || 'tester';

  const dir = tmp(ctx, prefix);

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
