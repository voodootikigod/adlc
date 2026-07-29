// §4b: `quartermaster.json` load-time validation — rules 1–7.
//
// Every rule here FAILS CLOSED (rule 5): a missing registry, a disabled path, a
// schema violation, or a requested channel with no entry aborts before dispatch.
// There are no defaults anywhere in this file. A registry that does not validate
// does not partially load — the operator gets an error naming the rule it broke.
//
// The adapter CATALOG is injected rather than imported. `packages/fleet` owns the
// adapter modules and consumes this package, so importing fleet here would make
// the publish graph circular; injection also keeps the alias contract
// adapter-owned (§4b rule 6) instead of duplicating harness knowledge here.

import {
  CHANNEL_NAMES,
  HARNESS_DEFAULT_MODEL,
  REVIEWER_GROUP_NAMES,
  TRANSPORT_PREFIXES,
  hasKnownTransportPrefix,
  isDirectTransport,
} from './channels.mjs';
import { isNormalizedProvider, normalizeProviderName } from './provider.mjs';

/** The one schema version this build understands. A newer registry fails closed. */
export const REGISTRY_SCHEMA_VERSION = 3;

export const RULE = Object.freeze({
  SCHEMA: 'rule 5 (fail closed — no defaults)',
  CLOSED_NAMES: 'rule 1 (closed channel names)',
  ADAPTER_ALLOWLIST: 'rule 2 (adapter allowlist)',
  FORCE_MODEL: 'rule 2 (§4c — adapter must force the model it is bound to)',
  ATTEST_ALIAS: 'rule 6 (§4c — an alias-based channel needs an adapter that attests the resolved model)',
  NO_ARGV: 'rule 2 (no command/argv-shaped fields)',
  DISTINCT_FALLBACK: 'rule 3 (frontier and frontier-metered transports must differ)',
  TRANSPORT_TAXONOMY: 'rule 4 (closed transport taxonomy)',
  DIRECT_AUTH: 'rule 4 (§6 — directAuth required on non-gateway members)',
  REVIEWER_ALIAS: 'rule 6 (no mutable aliases for reviewer-group members)',
  MODEL_PROVIDERS: 'rule 7 (concrete-model provider mapping)',
});

/**
 * Execution shape stays inside the adapter modules (rule 2). These key names are
 * rejected ANYWHERE in the document, at any depth — an operator-local file is
 * still a config file, and a config file that can name a binary or argv is a
 * config file that can run something the adapter never sanctioned.
 */
const ARGV_SHAPED_KEYS = Object.freeze([
  'command', 'cmd', 'args', 'argv', 'exec', 'shell', 'entrypoint',
  'bin', 'binary', 'flags', 'script', 'spawn', 'env',
]);

const TOP_LEVEL_KEYS = Object.freeze(['version', 'channels', 'reviewerGroups', 'modelProviders']);
const CHANNEL_KEYS = Object.freeze(['adapter', 'model', 'transport', 'provider', 'rateWindow']);
const GROUP_KEYS = Object.freeze(['quorum', 'members']);
const MEMBER_KEYS = Object.freeze(['adapter', 'model', 'transport', 'provider', 'directAuth']);

const RATE_WINDOW_PATTERN = /^[1-9][0-9]*[mhd]$/;

/** Thrown for any rule 1–7 violation. `violations` carries one entry per broken rule. */
export class RegistryValidationError extends Error {
  constructor(violations, { path } = {}) {
    const where = path ? ` (${path})` : '';
    super(
      `quartermaster registry is invalid${where} — ${violations.length} violation(s):\n` +
        violations.map((v) => `  - ${v.rule}: ${v.message}`).join('\n')
    );
    this.name = 'RegistryValidationError';
    this.violations = violations;
    this.path = path ?? null;
  }
}

/** Normalize an injected catalog into `Map<name, {aliases: Set<string>}>`. */
function normalizeCatalog(adapters) {
  const entries = adapters instanceof Map ? [...adapters.entries()] : Object.entries(adapters ?? {});
  return new Map(
    entries.map(([name, meta]) => [
      name,
      {
        aliases: new Set(meta?.aliases ?? []),
        forcesModel: meta?.forcesModel === true,
        attestsResolvedModel: meta?.attestsResolvedModel === true,
      },
    ])
  );
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk the whole document for argv-shaped keys (rule 2). */
function scanArgvShapedKeys(node, path, violations, seen = new Set()) {
  if (!isPlainObject(node) && !Array.isArray(node)) return;
  if (seen.has(node)) return; // a cyclic document is malformed, not a stack overflow
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((item, i) => scanArgvShapedKeys(item, `${path}[${i}]`, violations, seen));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (ARGV_SHAPED_KEYS.includes(key.toLowerCase())) {
      violations.push({
        rule: RULE.NO_ARGV,
        message:
          `${path}.${key} is a command/argv-shaped field. No such field exists in the schema at all — ` +
          'execution shape stays inside the adapter modules.',
      });
    }
    scanArgvShapedKeys(value, `${path}.${key}`, violations, seen);
  }
}

/** Reject keys outside a closed allowlist (rule 1 / rule 5). */
function checkUnknownKeys(node, allowed, path, violations, rule = RULE.SCHEMA) {
  for (const key of Object.keys(node)) {
    if (allowed.includes(key)) continue;
    if (ARGV_SHAPED_KEYS.includes(key.toLowerCase())) continue; // already reported against rule 2
    violations.push({
      rule,
      message: `${path}.${key} is not a known key; unknown keys are errors, not extensions (allowed: ${allowed.join(', ')}).`,
    });
  }
}

function requireString(value, label, violations, rule = RULE.SCHEMA) {
  if (typeof value !== 'string' || value.length === 0) {
    violations.push({ rule, message: `${label} must be a non-empty string (got ${JSON.stringify(value)}).` });
    return false;
  }
  return true;
}

/** Shared shape checks for a channel entry and a reviewer-group member. */
function checkSeat(seat, label, { catalog, violations, isReviewerMember }) {
  if (!isPlainObject(seat)) {
    violations.push({ rule: RULE.SCHEMA, message: `${label} must be an object (got ${JSON.stringify(seat)}).` });
    return;
  }
  checkUnknownKeys(seat, isReviewerMember ? MEMBER_KEYS : CHANNEL_KEYS, label, violations);

  const hasAdapter = requireString(seat.adapter, `${label}.adapter`, violations);
  if (hasAdapter && !catalog.has(seat.adapter)) {
    violations.push({
      rule: RULE.ADAPTER_ALLOWLIST,
      message:
        `${label}.adapter "${seat.adapter}" does not name a module in packages/fleet/lib/adapters/ ` +
        `(known adapters: ${[...catalog.keys()].join(', ')}).`,
    });
  }

  // §4c FORCE half: a seat that names a model must be bound to an adapter that
  // can actually put it on the command line. Otherwise the harness runs its
  // ambient default while the plan, the usage records, and any attestation all
  // claim the registry's model — silent substitution, which is the failure §4c
  // exists to prevent. `default` is exempt: it asks for the ambient default, so
  // an adapter with no model flag is telling the truth.
  if (
    hasAdapter &&
    typeof seat.model === 'string' &&
    seat.model !== HARNESS_DEFAULT_MODEL &&
    catalog.get(seat.adapter) &&
    !catalog.get(seat.adapter).forcesModel
  ) {
    violations.push({
      rule: RULE.FORCE_MODEL,
      message:
        `${label} names model "${seat.model}" on adapter "${seat.adapter}", which cannot pass an explicit model to ` +
        'its harness. The seat would silently run the harness default while reporting this model. Use an adapter ' +
        `that forces the model, or set model "${HARNESS_DEFAULT_MODEL}".`,
    });
  }

  if (requireString(seat.model, `${label}.model`, violations) && hasAdapter && isReviewerMember) {
    // Rule 6: reviewer identity must be a CONCRETE model ID. The alias set is
    // adapter-owned, so this rejects every alias the harness resolves at run
    // time — not merely the literal string 'default'.
    const aliases = catalog.get(seat.adapter)?.aliases ?? new Set();
    if (aliases.has(seat.model)) {
      violations.push({
        rule: RULE.REVIEWER_ALIAS,
        message:
          `${label}.model "${seat.model}" is a run-time alias declared by the "${seat.adapter}" adapter ` +
          `(declared aliases: ${[...aliases].join(', ')}). Reviewer identity must be a concrete model ID.`,
      });
    }
  }

  if (requireString(seat.transport, `${label}.transport`, violations, RULE.TRANSPORT_TAXONOMY)) {
    if (!hasKnownTransportPrefix(seat.transport)) {
      violations.push({
        rule: RULE.TRANSPORT_TAXONOMY,
        message:
          `${label}.transport "${seat.transport}" does not carry one of the closed prefixes ` +
          `${TRANSPORT_PREFIXES.join(', ')}. The prefix is load-bearing for §6 gateway discounting, so an ` +
          'unrecognized transport is rejected rather than treated as non-gateway.',
      });
    }
  }

  if (requireString(seat.provider, `${label}.provider`, violations) && !isNormalizedProvider(seat.provider)) {
    violations.push({
      rule: RULE.MODEL_PROVIDERS,
      message: `${label}.provider "${seat.provider}" is not a normalized provider string (NFKC, no whitespace, lower-case).`,
    });
  }

  if (isReviewerMember) {
    // §6: a member whose auth handshake is with the provider itself must SAY so,
    // because quorum collapses every gateway seat into one family.
    const direct = isDirectTransport(seat.transport);
    if (direct && seat.directAuth !== true) {
      violations.push({
        rule: RULE.DIRECT_AUTH,
        message:
          `${label} is on a non-gateway transport ("${seat.transport}") but does not set directAuth: true. ` +
          'Non-gateway members must declare direct auth — quorum diversity depends on it.',
      });
    }
    if (!direct && seat.directAuth === true) {
      violations.push({
        rule: RULE.DIRECT_AUTH,
        message:
          `${label} sets directAuth: true on a gateway transport ("${seat.transport}"). A mediated seat cannot ` +
          'claim a direct provider handshake.',
      });
    }
  } else if (seat.rateWindow !== undefined && !RATE_WINDOW_PATTERN.test(String(seat.rateWindow))) {
    violations.push({
      rule: RULE.SCHEMA,
      message: `${label}.rateWindow "${seat.rateWindow}" must look like "5h" (a positive count of m/h/d).`,
    });
  }
}

function checkChannels(channels, { catalog, violations }) {
  if (!isPlainObject(channels)) {
    violations.push({ rule: RULE.SCHEMA, message: 'channels must be an object.' });
    return;
  }
  for (const name of CHANNEL_NAMES) {
    if (!(name in channels)) {
      violations.push({ rule: RULE.CLOSED_NAMES, message: `channels.${name} is missing; every §4a channel must be present.` });
    }
  }
  for (const name of Object.keys(channels)) {
    if (!CHANNEL_NAMES.includes(name)) {
      violations.push({
        rule: RULE.CLOSED_NAMES,
        message:
          `channels.${name} is not a §4a channel name (allowed: ${CHANNEL_NAMES.join(', ')}). ` +
          'Adding a channel is a spec revision, not a config edit.',
      });
      continue;
    }
    checkSeat(channels[name], `channels.${name}`, { catalog, violations, isReviewerMember: false });
  }

  // Rule 3: the ONLY fallback edge exists to change transport, so identical
  // transports make it unsatisfiable by construction.
  const primary = channels.frontier?.transport;
  const metered = channels['frontier-metered']?.transport;
  if (typeof primary === 'string' && primary === metered) {
    violations.push({
      rule: RULE.DISTINCT_FALLBACK,
      message: `channels.frontier and channels.frontier-metered share transport "${primary}".`,
    });
  }
}

/**
 * The most independent families a member list could ever supply (§6).
 *
 * Gateway seats are keyed by their transport — an unauthenticated gateway can
 * alias or misroute model IDs, so everything behind one gateway proves only one
 * family however many providers it declares. Direct seats are keyed by
 * normalized provider, since two seats on the same provider are the same family
 * no matter how they are spelled.
 */
function effectiveFamilyCapacity(members) {
  const families = new Set();
  for (const member of members) {
    if (!isPlainObject(member) || typeof member.transport !== 'string') continue;
    families.add(
      isDirectTransport(member.transport)
        ? `direct:${normalizeProviderName(member.provider)}`
        : `gateway:${member.transport}`
    );
  }
  return families.size;
}

function checkReviewerGroups(groups, { catalog, violations }) {
  if (!isPlainObject(groups)) {
    violations.push({ rule: RULE.SCHEMA, message: 'reviewerGroups must be an object.' });
    return;
  }
  for (const name of REVIEWER_GROUP_NAMES) {
    if (!(name in groups)) {
      violations.push({ rule: RULE.CLOSED_NAMES, message: `reviewerGroups.${name} is missing; every §6 group must be present.` });
    }
  }
  for (const [name, group] of Object.entries(groups)) {
    const label = `reviewerGroups.${name}`;
    if (!REVIEWER_GROUP_NAMES.includes(name)) {
      violations.push({
        rule: RULE.CLOSED_NAMES,
        message: `${label} is not a §6 reviewer group (allowed: ${REVIEWER_GROUP_NAMES.join(', ')}).`,
      });
      continue;
    }
    if (!isPlainObject(group)) {
      violations.push({ rule: RULE.SCHEMA, message: `${label} must be an object.` });
      continue;
    }
    checkUnknownKeys(group, GROUP_KEYS, label, violations);

    const members = group.members;
    if (!Array.isArray(members) || members.length === 0) {
      violations.push({ rule: RULE.SCHEMA, message: `${label}.members must be a non-empty array.` });
    } else {
      members.forEach((member, i) =>
        checkSeat(member, `${label}.members[${i}]`, { catalog, violations, isReviewerMember: true })
      );
    }

    const quorum = group.quorum;
    const minQuorum = name === 'cross-model-trust-root' ? 2 : 1;
    if (!Number.isInteger(quorum) || quorum < minQuorum) {
      violations.push({
        rule: RULE.SCHEMA,
        message: `${label}.quorum must be an integer >= ${minQuorum} (§6; got ${JSON.stringify(quorum)}).`,
      });
    } else if (Array.isArray(members) && quorum > members.length) {
      violations.push({
        rule: RULE.SCHEMA,
        message: `${label}.quorum ${quorum} exceeds its ${members.length} member(s) — unsatisfiable by construction.`,
      });
    }

    // §6: all members behind one gateway count as ONE family, so a quorum >= 2
    // group needs at least one seat whose handshake is with the provider itself.
    if (Number.isInteger(quorum) && quorum >= 2 && Array.isArray(members)) {
      if (!members.some((m) => isPlainObject(m) && isDirectTransport(m.transport))) {
        violations.push({
          rule: RULE.DIRECT_AUTH,
          message:
            `${label} has quorum ${quorum} but no member on a subscription:*/api:* transport. All members sharing ` +
            'a gateway count as one family, so this quorum can never be satisfied.',
        });
      }
    }

    // Quorum counts FAMILIES, not seats (§6), so comparing it against the raw
    // member count accepts groups that can never be satisfied: members sharing
    // one gateway transport collapse to a single family, and two direct members
    // on the same provider are one family too. A group that cannot reach its own
    // quorum is unsatisfiable by construction — the same class of error rule 3
    // catches for the fallback edge — and every trust-root review would spend
    // its calls before failing under-satisfied.
    if (Number.isInteger(quorum) && Array.isArray(members) && members.length > 0) {
      const capacity = effectiveFamilyCapacity(members);
      if (capacity < quorum) {
        violations.push({
          rule: RULE.SCHEMA,
          message:
            `${label} has quorum ${quorum} but only ${capacity} independent famil${capacity === 1 ? 'y' : 'ies'} ` +
            `across its ${members.length} member(s): members sharing one gateway:* transport count as a single ` +
            'family (§6), as do direct members on the same provider. This quorum can never be satisfied.',
        });
      }
    }
  }
}

/** Every seat (channel or reviewer member) whose `model` is a concrete ID, not an alias. */
function* concreteSeats(channels, reviewerGroups, catalog) {
  const isConcrete = (seat) =>
    isPlainObject(seat) &&
    typeof seat.adapter === 'string' &&
    typeof seat.model === 'string' &&
    catalog.has(seat.adapter) &&
    !catalog.get(seat.adapter).aliases.has(seat.model);

  if (isPlainObject(channels)) {
    for (const [name, channel] of Object.entries(channels)) {
      if (isConcrete(channel)) yield [`channels.${name}`, channel];
    }
  }
  if (isPlainObject(reviewerGroups)) {
    for (const [name, group] of Object.entries(reviewerGroups)) {
      if (!isPlainObject(group) || !Array.isArray(group.members)) continue;
      for (const [i, member] of group.members.entries()) {
        if (isConcrete(member)) yield [`reviewerGroups.${name}.members[${i}]`, member];
      }
    }
  }
}

function checkModelProviders(table, { catalog, channels, reviewerGroups, violations }) {
  if (!isPlainObject(table)) {
    violations.push({ rule: RULE.MODEL_PROVIDERS, message: 'modelProviders must be an object mapping adapter → { model: provider }.' });
    return;
  }
  for (const [adapter, models] of Object.entries(table)) {
    const label = `modelProviders.${adapter}`;
    if (!catalog.has(adapter)) {
      violations.push({
        rule: RULE.ADAPTER_ALLOWLIST,
        message: `${label} does not name a module in packages/fleet/lib/adapters/.`,
      });
    }
    if (!isPlainObject(models)) {
      violations.push({ rule: RULE.MODEL_PROVIDERS, message: `${label} must be an object mapping concrete model → provider.` });
      continue;
    }
    for (const [model, provider] of Object.entries(models)) {
      // A key must actually name a model. An empty or whitespace key would
      // otherwise satisfy the alias-coverage count below while binding nothing,
      // which is the "looks covered, resolves to nothing" shape rule 7 exists to
      // prevent. (Staleness — a real but wrong model ID — remains undetectable
      // here; see the honest limit documented below.)
      if (model.trim().length === 0) {
        violations.push({
          rule: RULE.MODEL_PROVIDERS,
          message: `${label} has an empty model key. Every key must name a concrete model ID.`,
        });
      }
      if (!isNormalizedProvider(provider)) {
        violations.push({
          rule: RULE.MODEL_PROVIDERS,
          message:
            `${label}["${model}"] = ${JSON.stringify(provider)} is not a normalized provider string ` +
            '(NFKC-folded, whitespace-stripped, lower-case).',
        });
      }
    }
  }

  // Rule 7 coverage: phase-2 author binding resolves an ATTESTED concrete model
  // through this table only, and must never fall back to the declared provider.
  // An alias-based build channel therefore needs its adapter's resolutions
  // enumerated here — otherwise the binding is guaranteed to fail closed later,
  // and the right place to say so is load time.
  //
  // DOCUMENTED HONEST LIMIT. What follows checks that the adapter has SOME
  // mapping, not that every model its alias can resolve to is present — and it
  // cannot. A harness alias like claude-code's `default` tracks whatever
  // "latest" means today, so the resolution set is not enumerable from here at
  // load time; §4b's own reference registry relies on the operator listing the
  // models they expect. This check therefore catches the whole-table omission
  // (the common, total failure) and NOT a partial one. The real backstop for a
  // partial table is phase-2 binding failing closed on an unmapped attested
  // model (§6) — by design, after the work is spent. An operator who wants that
  // failure moved earlier should use concrete model IDs, which the spec offers
  // for exactly this reason ("Channels whose alias resolutions are not
  // enumerable must use concrete model IDs instead of aliases").
  // A CONCRETE model is fully checkable, so it is fully checked: the table must
  // carry it, and must agree with the seat's declared provider. A table that
  // omits it makes phase-2 binding fail closed after the build is paid for; a
  // table that CONTRADICTS it is worse than missing, because binding would then
  // resolve the author into the wrong family and could admit a same-family
  // reviewer that §6's exclusion is meant to keep out.
  for (const [label, seat] of concreteSeats(channels, reviewerGroups, catalog)) {
    const mapped = isPlainObject(table[seat.adapter]) ? table[seat.adapter][seat.model] : undefined;
    if (mapped === undefined) {
      violations.push({
        rule: RULE.MODEL_PROVIDERS,
        message:
          `${label} names concrete model "${seat.model}" on adapter "${seat.adapter}", but modelProviders.` +
          `${seat.adapter} has no entry for it. Phase-2 author binding resolves through this table only, so the ` +
          'binding could not complete.',
      });
    } else if (isNormalizedProvider(mapped) && typeof seat.provider === 'string' && mapped !== seat.provider) {
      violations.push({
        rule: RULE.MODEL_PROVIDERS,
        message:
          `${label} declares provider "${seat.provider}" but modelProviders.${seat.adapter}["${seat.model}"] says ` +
          `"${mapped}". A contradictory binding would resolve the author into the wrong family and could admit a ` +
          'same-family reviewer (§6).',
      });
    }
  }

  if (!isPlainObject(channels)) return;
  for (const [name, channel] of Object.entries(channels)) {
    if (!isPlainObject(channel) || typeof channel.adapter !== 'string' || typeof channel.model !== 'string') continue;
    const aliases = catalog.get(channel.adapter)?.aliases;
    if (!aliases?.has(channel.model)) continue; // concrete model — checked above

    // §4c round-11: an alias is a claim about what will run, and only
    // attestation can check it. Without `resolvedModel`, the harness is free to
    // resolve the alias from state the CANDIDATE controls — Claude Code, for
    // one, reads a project-committed `.claude/settings.json` model when no
    // --model is passed — so a repo could pick the model behind a channel the
    // operator believes they chose. Until an adapter attests, the spec's own
    // alternative applies: use a concrete model ID.
    if (!catalog.get(channel.adapter)?.attestsResolvedModel) {
      violations.push({
        rule: RULE.ATTEST_ALIAS,
        message:
          `channels.${name} binds the run-time alias "${channel.model}" to adapter "${channel.adapter}", which does ` +
          'not attest the model it actually ran. An unattested alias can be resolved from candidate-controlled ' +
          'state, so the channel would report a model nobody verified. Use a concrete model ID.',
      });
      // No `continue`: the coverage check below is still meaningful — an
      // operator fixing this by making the adapter attest (§9.3) should see BOTH
      // problems at once rather than one per fix cycle.
    }
    const covered = isPlainObject(table[channel.adapter])
      ? Object.keys(table[channel.adapter]).filter((m) => m.trim().length > 0).length
      : 0;
    if (covered === 0) {
      violations.push({
        rule: RULE.MODEL_PROVIDERS,
        message:
          `channels.${name} uses the run-time alias "${channel.model}" on adapter "${channel.adapter}", but ` +
          `modelProviders.${channel.adapter} maps no models. Nothing the alias can resolve to is mapped, so ` +
          'phase-2 author binding could never complete. Enumerate the resolutions or use a concrete model ID.',
      });
    }
  }
}

/**
 * Validate a parsed registry document against §4b rules 1–7.
 *
 * @param raw parsed JSON
 * @param adapters injected catalog: `{ [name]: { aliases: string[] } }` or a Map
 * @returns the validated document (frozen)
 * @throws {RegistryValidationError}
 */
export function validateRegistry(raw, { adapters, path } = {}) {
  const violations = [];
  const catalog = normalizeCatalog(adapters);
  if (catalog.size === 0) {
    throw new RegistryValidationError(
      [{ rule: RULE.ADAPTER_ALLOWLIST, message: 'no adapter catalog was supplied, so the adapter allowlist cannot be enforced.' }],
      { path }
    );
  }

  if (!isPlainObject(raw)) {
    throw new RegistryValidationError([{ rule: RULE.SCHEMA, message: 'registry must be a JSON object.' }], { path });
  }

  scanArgvShapedKeys(raw, 'registry', violations);
  checkUnknownKeys(raw, TOP_LEVEL_KEYS, 'registry', violations);

  if (raw.version !== REGISTRY_SCHEMA_VERSION) {
    violations.push({
      rule: RULE.SCHEMA,
      message: `registry.version must be ${REGISTRY_SCHEMA_VERSION} (got ${JSON.stringify(raw.version)}).`,
    });
  }

  checkChannels(raw.channels, { catalog, violations });
  checkReviewerGroups(raw.reviewerGroups, { catalog, violations });
  checkModelProviders(raw.modelProviders, {
    catalog,
    channels: raw.channels,
    reviewerGroups: raw.reviewerGroups,
    violations,
  });

  if (violations.length > 0) throw new RegistryValidationError(violations, { path });
  return Object.freeze(raw);
}
