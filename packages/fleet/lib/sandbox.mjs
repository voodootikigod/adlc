// The OS sandbox for BOTH planes (spec §7.3; adversarial-review F2/M1/K1/N1,
// issue #395).
//
// Network isolation and filesystem isolation are INDEPENDENT axes, and K2 only
// ever required the network one to differ between the planes. Each plane is a
// PROFILE over the same backend:
//
//   repo-command  network DENIED,  reads bounded, writes bounded
//                 (init/build/test/gate — the arbitrary-code surface)
//   model         network ALLOWED, reads at HOST scope, writes bounded
//                 (the `claude -p` worker — must reach its provider to work)
//
// Before #395 the model plane was not wrapped AT ALL, which made it a write path
// to everything the operator can write: the quartermaster registry, `~/.claude`
// settings and hooks, the installed toolkit, other repos' worktrees. That matters
// because the worker's permission allowlist contains repo-authored `fleet.gate`
// commands (config.mjs takes `gate` from the CANDIDATE tree) and the builder
// charter instructs it to run them — so candidate code executed with the
// operator's filesystem privileges.
//
// READS on the model plane stay at host scope, deliberately and as a DOCUMENTED
// RESIDUAL: the worker must reach whatever its harness keeps auth in, and that set
// is harness- and platform-specific (a Keychain item is not even a file). Bounding
// model-plane reads is a separate change; this profile closes the WRITE half,
// which is the half that makes a candidate's edit outlive its own run.
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

/** Network policy — the axis K2 makes the planes differ on. */
export const NETWORK = Object.freeze({ DENY: 'deny', ALLOW: 'allow' });

/**
 * Read policy — the axis they do NOT differ on today.
 *
 * `bounded` reads only the worktree, the synthetic home, and an explicit
 * read-only allowlist. `host` reads whatever the invoking user can read.
 * `host` is the model plane's documented residual (see the module header): it is
 * NOT a claim of containment, and `canRead` reports it honestly rather than
 * pretending a boundary exists.
 */
export const READ_POLICY = Object.freeze({ BOUNDED: 'bounded', HOST: 'host' });

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

// Device nodes the model plane may write. /dev is a device tree, not persistent
// operator state, so granting it does not widen what a candidate's edit can
// outlive. Named here so `canWrite` and the Seatbelt profile cannot disagree.
const DEVICE_WRITE_ROOTS = Object.freeze(['/dev']);

function isUnder(root, path) {
  const r = resolve(root);
  const p = resolve(path);
  return p === r || p.startsWith(r + sep);
}

/**
 * Build the wrapper argv that runs `innerArgv` inside the backend (adversarial-review
 * K1; per-plane profiles per issue #395). Only used for real `sandbox`-mode
 * backends. Kept side-effect-free and testable: it just assembles the argv.
 *
 * @param opts.network      NETWORK.DENY (repo-command plane) | NETWORK.ALLOW (model plane)
 * @param opts.readPolicy   READ_POLICY.BOUNDED | READ_POLICY.HOST
 * @param opts.readOnlyPaths  extra readable roots (BOUNDED only — HOST already reads them)
 * @param opts.writablePaths  extra WRITABLE roots beyond the worktree/synthetic home.
 *   On the model plane this is the configured harness's own state directories: a
 *   harness that cannot write its session state cannot run, and denying by default
 *   with a NAMED exception list is the only direction where forgetting a path fails
 *   LOUDLY (the harness errors) instead of silently reopening the hole.
 */
export function buildSandboxArgv(backend, innerArgv, {
  worktree,
  syntheticHome,
  readOnlyPaths = [],
  writablePaths = [],
  network = NETWORK.DENY,
  readPolicy = READ_POLICY.BOUNDED,
} = {}) {
  const writeRoots = [worktree, syntheticHome, ...writablePaths].filter(Boolean);
  if (backend.name === 'bubblewrap') {
    const args = [];
    if (network === NETWORK.DENY) args.push('--unshare-net');
    args.push('--die-with-parent', '--chdir', worktree);
    if (readPolicy === READ_POLICY.HOST) {
      // Whole filesystem visible but READ-ONLY, then the write roots re-bound over
      // it. Later binds win in bwrap, so ordering IS the policy here. /dev needs a
      // device bind (a process that cannot write /dev/null cannot run).
      args.push('--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc');
      for (const rw of writeRoots) args.push('--bind', rw, rw);
      // HOME is deliberately NOT remapped: the worker reads its own
      // subscription/session auth from the real one (K2), and Seatbelt cannot
      // remap a path at all — inventing a synthetic home here would make the two
      // backends enforce different policies under one name.
      return ['bwrap', ...args, '--', ...innerArgv];
    }
    // read-write: worktree + synthetic home; read-only: runtime paths only.
    for (const rw of writeRoots) args.push('--bind', rw, rw);
    for (const ro of readOnlyPaths) args.push('--ro-bind', ro, ro);
    args.push('--setenv', 'HOME', syntheticHome ?? worktree);
    return ['bwrap', ...args, '--', ...innerArgv];
  }
  if (backend.name === 'seatbelt') {
    const profile = seatbeltProfile({ worktree, syntheticHome, readOnlyPaths, writablePaths, network, readPolicy });
    return ['sandbox-exec', '-p', profile, ...innerArgv];
  }
  throw new Error(`unknown sandbox backend: ${backend.name}`);
}

// Seatbelt has no bind/remap primitive — a profile can only permit or deny paths
// in place. That is why HOST read policy is expressed as "allow default, then deny
// writes, then re-allow the write roots": in SBPL a later rule overrides an earlier
// one, so this is a deny-by-default WRITE policy layered on an open READ policy.
function seatbeltProfile({
  worktree, syntheticHome, readOnlyPaths = [], writablePaths = [],
  network = NETWORK.DENY, readPolicy = READ_POLICY.BOUNDED,
}) {
  const writeRoots = [worktree, syntheticHome, ...writablePaths].filter(Boolean);
  const lit = (p) => `(subpath "${p}")`;
  if (readPolicy === READ_POLICY.HOST) {
    return [
      '(version 1)',
      '(allow default)',
      network === NETWORK.DENY ? '(deny network*)' : '(allow network*)',
      '(deny file-write*)',
      // Device nodes are not persistent state, and a process that cannot write
      // /dev/null cannot run: `cmd 2>/dev/null` is ordinary in build and gate
      // commands, and the blanket denial above would fail it. bwrap covers this
      // with --dev-bind; Seatbelt needs it stated. Kept as its own rule rather
      // than folded into writeRoots so the two backends stay legibly equivalent.
      `(allow file-write* ${DEVICE_WRITE_ROOTS.map(lit).join(' ')})`,
      `(allow file-write* ${writeRoots.map(lit).join(' ')})`,
    ].join(' ');
  }
  const readRoots = [worktree, syntheticHome, ...readOnlyPaths].filter(Boolean);
  return [
    '(version 1)',
    '(deny default)',
    network === NETWORK.DENY ? '(deny network*)' : '(allow network*)',
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
  constructor({
    mode, backend, worktree, syntheticHome, readOnlyPaths = [], writablePaths = [],
    network = NETWORK.DENY, readPolicy = READ_POLICY.BOUNDED, exec,
  } = {}) {
    this.mode = mode;
    this.backend = backend ?? null;
    this.worktree = worktree;
    this.syntheticHome = syntheticHome;
    this.readOnlyPaths = readOnlyPaths;
    this.writablePaths = writablePaths;
    this.network = network;
    this.readPolicy = readPolicy;
    this._exec = exec; // injectable for tests: (argv, opts) => result
  }

  get networkAllowed() {
    // ENV_SCRUB_ONLY relies on external isolation, so it claims nothing. Under a
    // real backend the answer is the PROFILE's, not the plane's name: the model
    // plane allows egress (K2 — the worker must reach its provider), the
    // repo-command plane denies it.
    if (this.mode !== SANDBOX_MODES.SANDBOX) return true;
    return this.network === NETWORK.ALLOW;
  }

  /** True if the sandbox permits reading `path` (K1 read isolation). */
  canRead(path) {
    if (this.mode !== SANDBOX_MODES.SANDBOX) return true;
    // HOST read policy claims no read boundary and says so, rather than reporting
    // a containment the profile does not enforce (issue #395 residual).
    if (this.readPolicy === READ_POLICY.HOST) return true;
    const roots = [this.worktree, this.syntheticHome, ...this.readOnlyPaths].filter(Boolean);
    return roots.some((r) => isUnder(r, path));
  }

  /** True if the sandbox permits writing `path`. */
  canWrite(path) {
    if (this.mode !== SANDBOX_MODES.SANDBOX) return true;
    const roots = [this.worktree, this.syntheticHome, ...this.writablePaths].filter(Boolean);
    // HOST read policy also grants the device tree (see DEVICE_WRITE_ROOTS), and
    // the predicate says so — a predicate that disagreed with the profile would
    // be the thing tests trust while the sandbox does something else.
    if (this.readPolicy === READ_POLICY.HOST) {
      roots.push(...DEVICE_WRITE_ROOTS);
    }
    return roots.some((r) => isUnder(r, path));
  }

  /** Wrap `innerArgv` for execution (no-op prefix in ENV_SCRUB_ONLY mode). */
  wrap(innerArgv) {
    if (this.mode !== SANDBOX_MODES.SANDBOX) return innerArgv;
    return buildSandboxArgv(this.backend, innerArgv, {
      worktree: this.worktree,
      syntheticHome: this.syntheticHome,
      readOnlyPaths: this.readOnlyPaths,
      writablePaths: this.writablePaths,
      network: this.network,
      readPolicy: this.readPolicy,
    });
  }

  /**
   * Execute `innerArgv` inside the sandbox with the given scrubbed env. Async so
   * a live (promise-returning) exec does not block the event loop (#164); a
   * synchronous injected exec still works (await of a plain value is a no-op).
   */
  async run(innerArgv, opts = {}) {
    const exec = this._exec ?? realExec;
    // Forward the WHOLE option bag, not a hand-picked {env, cwd}: the model plane
    // passes `timeout` (the per-strike worker deadline) and `input` (the stdin
    // prompt transport some harnesses use), and silently dropping either turns a
    // wrapped dispatch into one that never times out or never receives its prompt.
    return await exec(this.wrap(innerArgv), { ...opts, cwd: opts.cwd ?? this.worktree });
  }
}

function realExec(argv, opts) {
  const [cmd, ...rest] = argv;
  return execFileSync(cmd, rest, { ...opts, encoding: 'utf8' });
}
