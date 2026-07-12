// The OS sandbox for the repo-command plane (spec §7.3; adversarial-review
// F2/M1/K1/N1). Init, build, test, and gate commands — the arbitrary-code
// surface — run inside it: network denied, filesystem reads AND writes bounded
// to the worktree (+ synthetic HOME + an explicit read-only runtime allowlist).
// The `claude -p` worker runs on the SEPARATE model plane and is NOT wrapped
// here (K2), so it can still reach its provider.
//
// This module is deliberately backend-pluggable and pure where it can be: the
// mode-resolution policy and the read/write/network predicates are unit-testable
// without any real sandbox binary.

import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

export const SANDBOX_MODES = Object.freeze({
  SANDBOX: 'sandbox',
  ENV_SCRUB_ONLY: 'env-scrub-only',
});

function defaultHasCmd(cmd) {
  try {
    execFileSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the host for a sandbox backend that provides BOTH network AND filesystem
 * isolation (adversarial-review C2). Linux uses bubblewrap (`bwrap`,
 * user-namespace with fine-grained binds); macOS uses Seatbelt (`sandbox-exec`).
 *
 * Plain `unshare --net` is deliberately NOT accepted: it creates a network
 * namespace but leaves the host filesystem fully visible, which would violate
 * the canRead/canWrite boundary this module promises. A host with `unshare` but
 * no `bwrap` therefore reports NO backend and the fleet fails closed (or requires
 * the operator's disposable-container override) rather than claiming a
 * containment it cannot deliver.
 */
export function detectBackend(platform = process.platform, hasCmd = defaultHasCmd) {
  if (platform === 'linux' && hasCmd('bwrap')) return { name: 'bubblewrap', platform };
  if (platform === 'darwin' && hasCmd('sandbox-exec')) return { name: 'seatbelt', platform };
  return null;
}

/**
 * Decide the sandbox mode, failing CLOSED (adversarial-review F2/N1).
 *
 * - A detected backend → `sandbox` mode (full containment).
 * - No backend but an OPERATOR-LOCAL override (CLI flag / untracked user config)
 *   → `env-scrub-only`, trusting the operator's disposable container.
 * - No backend and no operator override → REFUSE (mode null, refused:true).
 *
 * `repoConfigOverride` is a repo-COMMITTED surface, so it can NEVER enable the
 * override (N1): if set it is ignored with a warning and the decision is made as
 * if it were absent.
 */
export function resolveSandboxMode({ backend, operatorOverride = false, repoConfigOverride = false } = {}) {
  const warnings = [];
  if (repoConfigOverride) {
    warnings.push(
      'SECURITY: .adlc/config.json requested the disposable-container override, but repo-committed ' +
        'config CANNOT disable the sandbox (adversarial-review N1). Ignoring it.'
    );
  }
  if (backend) {
    return { mode: SANDBOX_MODES.SANDBOX, backend, warnings, refused: false };
  }
  if (operatorOverride) {
    warnings.push(
      'No OS sandbox backend detected; --i-am-in-a-disposable-container is set → running ' +
        'ENV-SCRUB-ONLY. This is safe ONLY inside an isolated, secret-free, network-denied container.'
    );
    return { mode: SANDBOX_MODES.ENV_SCRUB_ONLY, backend: null, warnings, refused: false };
  }
  return {
    mode: null,
    backend: null,
    warnings,
    refused: true,
    reason:
      'No OS sandbox backend available and no operator-local disposable-container override. ' +
      'Refusing to dispatch (fail closed) — the repo-command plane runs arbitrary code and must be contained.',
  };
}

function isUnder(root, path) {
  const r = resolve(root);
  const p = resolve(path);
  return p === r || p.startsWith(r + sep);
}

/**
 * Build the wrapper argv that runs `innerArgv` inside the backend with network
 * denied and reads/writes bounded (adversarial-review K1). Only used for real
 * `sandbox`-mode backends. Kept side-effect-free and testable: it just assembles
 * the argv.
 */
export function buildSandboxArgv(backend, innerArgv, { worktree, syntheticHome, readOnlyPaths = [] }) {
  if (backend.name === 'bubblewrap') {
    const args = ['--unshare-net', '--die-with-parent', '--chdir', worktree];
    // read-write: worktree + synthetic home; read-only: runtime paths only.
    args.push('--bind', worktree, worktree);
    if (syntheticHome) args.push('--bind', syntheticHome, syntheticHome);
    for (const ro of readOnlyPaths) args.push('--ro-bind', ro, ro);
    args.push('--setenv', 'HOME', syntheticHome ?? worktree);
    return ['bwrap', ...args, '--', ...innerArgv];
  }
  if (backend.name === 'seatbelt') {
    const profile = seatbeltProfile({ worktree, syntheticHome, readOnlyPaths });
    return ['sandbox-exec', '-p', profile, ...innerArgv];
  }
  throw new Error(`unknown sandbox backend: ${backend.name}`);
}

function seatbeltProfile({ worktree, syntheticHome, readOnlyPaths = [] }) {
  const readRoots = [worktree, syntheticHome, ...readOnlyPaths].filter(Boolean);
  const writeRoots = [worktree, syntheticHome].filter(Boolean);
  const lit = (p) => `(subpath "${p}")`;
  return [
    '(version 1)',
    '(deny default)',
    '(deny network*)',
    `(allow file-read* ${readRoots.map(lit).join(' ')})`,
    `(allow file-write* ${writeRoots.map(lit).join(' ')})`,
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
  ].join(' ');
}

/**
 * A resolved sandbox for one run. Exposes the containment predicates the design
 * relies on (so tests can assert read/write/network isolation directly) plus a
 * `run` that executes a command inside it. In ENV_SCRUB_ONLY mode there is no OS
 * enforcement — the operator asserted the whole run is already contained — so the
 * predicates return true and `run` executes directly with the scrubbed env.
 */
export class Sandbox {
  constructor({ mode, backend, worktree, syntheticHome, readOnlyPaths = [], exec } = {}) {
    this.mode = mode;
    this.backend = backend ?? null;
    this.worktree = worktree;
    this.syntheticHome = syntheticHome;
    this.readOnlyPaths = readOnlyPaths;
    this._exec = exec; // injectable for tests: (argv, {cwd, env}) => result
  }

  get networkAllowed() {
    // Only ENV_SCRUB_ONLY relies on external isolation; the OS sandbox denies net.
    return this.mode !== SANDBOX_MODES.SANDBOX ? true : false;
  }

  /** True if the sandbox permits reading `path` (K1 read isolation). */
  canRead(path) {
    if (this.mode !== SANDBOX_MODES.SANDBOX) return true;
    const roots = [this.worktree, this.syntheticHome, ...this.readOnlyPaths].filter(Boolean);
    return roots.some((r) => isUnder(r, path));
  }

  /** True if the sandbox permits writing `path`. */
  canWrite(path) {
    if (this.mode !== SANDBOX_MODES.SANDBOX) return true;
    const roots = [this.worktree, this.syntheticHome].filter(Boolean);
    return roots.some((r) => isUnder(r, path));
  }

  /** Wrap `innerArgv` for execution (no-op prefix in ENV_SCRUB_ONLY mode). */
  wrap(innerArgv) {
    if (this.mode !== SANDBOX_MODES.SANDBOX) return innerArgv;
    return buildSandboxArgv(this.backend, innerArgv, {
      worktree: this.worktree,
      syntheticHome: this.syntheticHome,
      readOnlyPaths: this.readOnlyPaths,
    });
  }

  /**
   * Execute `innerArgv` inside the sandbox with the given scrubbed env. Async so
   * a live (promise-returning) exec does not block the event loop (#164); a
   * synchronous injected exec still works (await of a plain value is a no-op).
   */
  async run(innerArgv, { env, cwd } = {}) {
    const exec = this._exec ?? realExec;
    return await exec(this.wrap(innerArgv), { cwd: cwd ?? this.worktree, env });
  }
}

function realExec(argv, opts) {
  const [cmd, ...rest] = argv;
  return execFileSync(cmd, rest, { ...opts, encoding: 'utf8' });
}
