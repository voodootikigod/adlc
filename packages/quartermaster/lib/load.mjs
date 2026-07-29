// §4b: read the one registry dispatch is allowed to read — and say out loud
// which ones it refused to read.
//
// Fail-closed (rule 5) means the ONLY successful outcome is "an operator-local
// file outside the candidate tree parsed and validated". A disabled path, an
// absent file, unreadable bytes, or malformed JSON all abort before dispatch;
// none of them fall back to a default registry, because a default registry is a
// channel selection nobody authorized.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { resolveRegistryPath, findIgnoredInRepoRegistries } from './registry-path.mjs';
import { validateRegistry } from './registry.mjs';

/** Thrown when no registry could be loaded. Carries the notices for the operator. */
export class RegistryLoadError extends Error {
  constructor(message, { notices = [], path = null } = {}) {
    super(message);
    this.name = 'RegistryLoadError';
    this.notices = notices;
    this.path = path;
  }
}

/**
 * Load and validate the operator-local registry.
 *
 * @returns {{ registry: object, path: string, notices: string[] }}
 * @throws {RegistryLoadError|RegistryValidationError}
 */
export function loadRegistry({
  env = process.env,
  repoDir,
  adapters,
  homedir = osHomedir,
  readFile = (p) => readFileSync(p, 'utf8'),
  exists = existsSync,
  realpath = realpathSync,
} = {}) {
  const notices = [];

  // A registry-shaped file in the candidate tree is IGNORED, always — but never
  // silently. Naming it is what turns an attempted downgrade into an audit line
  // (§4 design rule, AC1).
  for (const ignored of findIgnoredInRepoRegistries(repoDir, { exists })) {
    notices.push(
      `quartermaster: IGNORED registry-shaped file inside the repo under review (${ignored}). ` +
        'Nothing in a candidate tree selects channels; only the operator-local registry is read.'
    );
  }

  const resolved = resolveRegistryPath({ env, repoDir, homedir, realpath });
  if (resolved.notice) notices.push(resolved.notice);
  if (resolved.disabled) {
    throw new RegistryLoadError(`${resolved.notice} Dispatch fails closed.`, { notices });
  }

  if (!exists(resolved.path)) {
    throw new RegistryLoadError(
      `quartermaster: no registry at ${resolved.path}. Dispatch fails closed — there are no default channels.`,
      { notices, path: resolved.path }
    );
  }

  let text;
  try {
    text = readFile(resolved.path);
  } catch (e) {
    throw new RegistryLoadError(`quartermaster: cannot read registry ${resolved.path}: ${e.message}`, {
      notices,
      path: resolved.path,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new RegistryLoadError(`quartermaster: registry ${resolved.path} is not valid JSON: ${e.message}`, {
      notices,
      path: resolved.path,
    });
  }

  const registry = validateRegistry(parsed, { adapters, path: resolved.path });
  return { registry, path: resolved.path, notices };
}

/**
 * Resolve a routing result to the concrete seat dispatch needs.
 *
 * Rule 5 again: a channel the routing contract requests that has no registry
 * entry is a gate failure, not a fallback.
 *
 * @returns {{ adapter, model, transport, provider, rateWindow? }} for a channel
 *   route, or `{ group, quorum, members }` for a reviewer-group route.
 */
export function resolveRoute(registry, route) {
  if (route?.deterministic === true) {
    throw new Error('quartermaster: a deterministic gate takes no channel — nothing to resolve (§5).');
  }
  if (route?.channel) {
    const entry = registry?.channels?.[route.channel];
    if (!entry) {
      throw new RegistryLoadError(
        `quartermaster: the routing contract requested channel "${route.channel}" but the registry has no entry for it (§4b rule 5).`
      );
    }
    return { ...entry };
  }
  if (route?.reviewerGroup) {
    const group = registry?.reviewerGroups?.[route.reviewerGroup];
    if (!group) {
      throw new RegistryLoadError(
        `quartermaster: the routing contract requested reviewer group "${route.reviewerGroup}" but the registry has no entry for it (§4b rule 5).`
      );
    }
    return { group: route.reviewerGroup, quorum: group.quorum, members: group.members.map((m) => ({ ...m })) };
  }
  throw new Error(`quartermaster: unroutable result ${JSON.stringify(route)}.`);
}
