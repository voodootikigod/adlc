// §4b: where `quartermaster.json` may live — and where it may NOT.
//
// The registry is operator-local, ENTIRELY (§4, design rule from review round 2).
// The candidate tree participates in channel selection not at all, so a
// configured path that is relative or inside the repo under review DISABLES the
// registry with a loud notice rather than loading it — exactly how the
// adversarial-review CLI treats ADVERSARIAL_REVIEW_CONFIG. Disabling (rather
// than erroring quietly) is what makes the downgrade attempt visible: a repo
// that ships its own registry and points the env var at it gets a notice naming
// the file, then a fail-closed dispatch, never a cheap frontier.

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';

export const REGISTRY_ENV = 'ADLC_QUARTERMASTER_REGISTRY';
export const REGISTRY_BASENAME = 'quartermaster.json';

/** In-repo locations scanned purely so an ignored registry can be NAMED (§4b, AC1). */
export const IN_REPO_REGISTRY_PATHS = Object.freeze([REGISTRY_BASENAME, join('.adlc', REGISTRY_BASENAME)]);

/**
 * Resolve a path through symlinks as far as it actually exists, then re-append
 * the missing tail.
 *
 * Containment MUST be decided on real paths: on macOS the system temp dir is a
 * symlink (`/tmp` → `/private/tmp`), so a lexical comparison calls two paths
 * distinct that are the same directory. Comparing lexically would make the
 * in-repo check pass locally and fail on Linux CI (or worse, the reverse — a
 * registry genuinely inside the repo judged outside it).
 */
function resolveReal(target, realpath) {
  let head = resolve(target);
  const tail = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpath(head) : join(realpath(head), ...tail);
    } catch {
      const parent = resolve(head, '..');
      if (parent === head) return resolve(target); // hit the root; nothing exists
      tail.unshift(head.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      head = parent;
    }
  }
}

/** True if `child` is `parent` itself or lives underneath it (real paths). */
export function isInside(child, parent, { realpath = realpathSync } = {}) {
  const rel = relative(resolveReal(parent, realpath), resolveReal(child, realpath));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Decide which registry file dispatch is allowed to read.
 *
 * @param repoDir the candidate tree — required; the containment rule is the
 *   whole point of this function, so a caller that cannot name the repo under
 *   review gets a fail-closed disable rather than an unguarded read.
 * @returns {{ path: string|null, disabled: boolean, notice: string|null, source: string }}
 */
export function resolveRegistryPath({ env = process.env, repoDir, homedir = osHomedir, realpath = realpathSync } = {}) {
  if (typeof repoDir !== 'string' || repoDir.length === 0) {
    return {
      path: null,
      disabled: true,
      source: 'none',
      notice:
        'quartermaster: registry loading DISABLED — no repo directory was supplied, so the operator-local path ' +
        'rule (§4b) cannot be enforced. Refusing to read a registry unguarded.',
    };
  }

  const configured = env[REGISTRY_ENV];
  if (typeof configured === 'string' && configured.length > 0) {
    if (!isAbsolute(configured)) {
      return {
        path: null,
        disabled: true,
        source: 'env',
        notice:
          `quartermaster: registry loading DISABLED — ${REGISTRY_ENV}="${configured}" is a RELATIVE path. ` +
          'The registry must be an operator-local absolute path outside the repo under review (§4b).',
      };
    }
    if (isInside(configured, repoDir, { realpath })) {
      return {
        path: null,
        disabled: true,
        source: 'env',
        notice:
          `quartermaster: registry loading DISABLED — ${REGISTRY_ENV}="${configured}" points INSIDE the repo ` +
          `under review (${repoDir}). Nothing in a candidate tree may select channels (§4, §10).`,
      };
    }
    return { path: configured, disabled: false, notice: null, source: 'env' };
  }

  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  const fallback = join(configHome, 'adlc', REGISTRY_BASENAME);
  if (isInside(fallback, repoDir, { realpath })) {
    return {
      path: null,
      disabled: true,
      source: 'xdg',
      notice:
        `quartermaster: registry loading DISABLED — the default registry path (${fallback}) resolves INSIDE the ` +
        `repo under review (${repoDir}). Nothing in a candidate tree may select channels (§4, §10).`,
    };
  }
  return { path: fallback, disabled: false, notice: null, source: 'xdg' };
}

/**
 * Registry-shaped files sitting in the candidate tree. They are never read —
 * this exists so dispatch can say out loud that it ignored one (AC1).
 */
export function findIgnoredInRepoRegistries(repoDir, { exists } = {}) {
  if (typeof repoDir !== 'string' || repoDir.length === 0 || typeof exists !== 'function') return [];
  return IN_REPO_REGISTRY_PATHS.map((rel) => join(repoDir, rel)).filter((p) => exists(p));
}
