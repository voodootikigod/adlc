// Seatbelt-escaped wrapper around the frozen Sandbox rail (packages/fleet/lib/sandbox.mjs).
//
// `lib/sandbox.mjs` is an active frozen rail and its `seatbeltProfile` interpolates paths
// directly into `(subpath "${p}")`. A path containing `"`, `\`, or NUL/newline control
// characters on macOS (`sandbox-exec -p`) could break out of the string literal and inject
// arbitrary SBPL s-expressions (such as `(allow default)` or `(allow network*)`).
//
// `SafeSandbox` preserves every `Sandbox` method and containment predicate verbatim while
// escaping all Seatbelt subpath literals via `@adlc/core`'s `escapeSeatbeltPath`.

import { escapeSeatbeltPath } from '@adlc/core';
import { Sandbox, SANDBOX_MODES, NETWORK, READ_POLICY } from './sandbox.mjs';

const DEVICE_WRITE_ROOTS = Object.freeze(['/dev']);

/**
 * Assemble a Seatbelt SBPL profile with every subpath escaped via `escapeSeatbeltPath`
 * (rejecting NUL/CR/LF and escaping `\` and `"`).
 */
export function buildSafeSeatbeltProfile({
  worktree,
  syntheticHome,
  readOnlyPaths = [],
  writablePaths = [],
  network = NETWORK.DENY,
  readPolicy = READ_POLICY.BOUNDED,
} = {}) {
  const writeRoots = [worktree, syntheticHome, ...writablePaths].filter(Boolean);
  const lit = (p) => `(subpath "${escapeSeatbeltPath(p)}")`;
  if (readPolicy === READ_POLICY.HOST) {
    const clauses = [
      '(version 1)',
      '(allow default)',
      network === NETWORK.DENY ? '(deny network*)' : '(allow network*)',
      '(deny file-write*)',
      `(allow file-write* ${DEVICE_WRITE_ROOTS.map(lit).join(' ')})`,
    ];
    if (writeRoots.length > 0) {
      clauses.push(`(allow file-write* ${writeRoots.map(lit).join(' ')})`);
    }
    return clauses.join(' ');
  }
  const readRoots = [worktree, syntheticHome, ...readOnlyPaths].filter(Boolean);
  const clauses = [
    '(version 1)',
    '(deny default)',
    network === NETWORK.DENY ? '(deny network*)' : '(allow network*)',
  ];
  if (readRoots.length > 0) {
    clauses.push(`(allow file-read* ${readRoots.map(lit).join(' ')})`);
  }
  if (writeRoots.length > 0) {
    clauses.push(`(allow file-write* ${writeRoots.map(lit).join(' ')})`);
  }
  clauses.push('(allow process-exec)', '(allow process-fork)', '(allow sysctl-read)');
  return clauses.join(' ');
}

export class SafeSandbox extends Sandbox {
  wrap(innerArgv) {
    if (
      !Array.isArray(innerArgv) ||
      innerArgv.length === 0 ||
      typeof innerArgv[0] !== 'string' ||
      innerArgv[0].length === 0 ||
      innerArgv[0].startsWith('-')
    ) {
      throw new Error('SafeSandbox.wrap requires a non-empty command argv whose executable does not start with "-"');
    }
    if (this.mode !== SANDBOX_MODES.SANDBOX) return innerArgv;
    if (this.backend?.name === 'seatbelt') {
      const profile = buildSafeSeatbeltProfile({
        worktree: this.worktree,
        syntheticHome: this.syntheticHome,
        readOnlyPaths: this.readOnlyPaths,
        writablePaths: this.writablePaths,
        network: this.network,
        readPolicy: this.readPolicy,
      });
      return ['sandbox-exec', '-p', profile, ...innerArgv];
    }
    return super.wrap(innerArgv);
  }
}
