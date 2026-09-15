/**
 * The repo profile — the one machine-parsed config in this package.
 *
 * WHY IT FAILS CLOSED (spec §2.1). A config that ignores keys it does not
 * understand hands the operator a setting they believe is in force and is not.
 * `autonmyFloor` would leave the floor at its default while the file appears to
 * say otherwise, and the operator would only discover it after something closed
 * that should not have. So an unrecognised key — at any depth — is an
 * operational error, exactly as `packages/model-router/lib/floor.mjs` refuses a
 * value outside its range rather than clamping it.
 *
 * This module PARSES the profile. It does not enforce the autonomy floor:
 * validating class names and comparing against the merge base is the write
 * path's job (spec §3.7). `autonomyFloor` is carried through verbatim so the
 * write path can tell an explicitly-empty floor from an omitted one — a
 * distinction §3.7 depends on, since omission must yield the conservative
 * default and only a deliberate `[]` may widen.
 */

/** Profile schema versions this build understands. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);

/**
 * The documented defaults (spec §2.1). Deep-frozen: `parseProfile` hands back a
 * fresh object every time, and nothing may mutate the shared default into a
 * different one for every later caller.
 */
export const DEFAULT_PROFILE = deepFreeze({
  autonomyFloor: ['close'],
  units: [],
  frozenPaths: [],
  labels: {
    priority: { high: 'P1-high', medium: 'P2-medium', low: 'P3-low' },
    areaPrefix: 'area:',
  },
  providers: {},
});

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'autonomyFloor', 'units', 'frozenPaths', 'labels', 'providers']);
const LABELS_KEYS = new Set(['priority', 'areaPrefix']);
const PRIORITY_KEYS = new Set(['high', 'medium', 'low']);
const PROVIDERS_KEYS = new Set(['decider', 'reviewer']);
const UNIT_KEYS = new Set(['name', 'paths']);

function opError(message) {
  return Object.assign(new Error(message), { isOpError: true });
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reject the first key not in `allowed`, naming it and where it sat.
 *
 * The key is named because the whole point is that a typo is findable: "unknown
 * key" without the key is the same dead end as ignoring it.
 */
function rejectUnknownKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      const known = [...allowed].join(', ');
      throw opError(`backlog-groom profile: unknown key ${JSON.stringify(key)} in ${where} — known keys are: ${known}`);
    }
  }
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (isPlainObject(v) || Array.isArray(v)) deepFreeze(v);
  return Object.freeze(o);
}

/** A structured clone deep enough for the profile's shapes (objects/arrays/scalars). */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

/**
 * Parse and validate a profile document, returning a fresh, fully-defaulted
 * profile.
 *
 * A supplied value is taken VERBATIM and never merged field-wise into the
 * default: an operator who writes one priority mapping has told us their whole
 * mapping, and quietly restoring the missing entries would invent labels they
 * never declared. Sibling keys still default independently, because leaving
 * `labels.priority` out is not a statement about `labels.areaPrefix`.
 *
 * @param {unknown} doc - the parsed JSON profile document
 * @returns {{schemaVersion:number, autonomyFloor:string[], units:object[], frozenPaths:string[], labels:object, providers:object}}
 * @throws {Error & {isOpError:true}} on an unknown key, a bad schemaVersion, or a non-object
 */
export function parseProfile(doc) {
  if (!isPlainObject(doc)) {
    throw opError(`backlog-groom profile: expected a JSON object, got ${Array.isArray(doc) ? 'an array' : typeof doc}`);
  }
  rejectUnknownKeys(doc, TOP_LEVEL_KEYS, 'the profile');

  if (!Object.hasOwn(doc, 'schemaVersion')) {
    throw opError('backlog-groom profile: schemaVersion is required');
  }
  const version = doc.schemaVersion;
  if (!Number.isInteger(version) || !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    throw opError(
      `backlog-groom profile: unsupported schemaVersion ${JSON.stringify(version)} — this build understands: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`
    );
  }

  if (Object.hasOwn(doc, 'labels')) {
    if (!isPlainObject(doc.labels)) throw opError('backlog-groom profile: labels must be an object');
    rejectUnknownKeys(doc.labels, LABELS_KEYS, 'labels');
    if (Object.hasOwn(doc.labels, 'priority')) {
      if (!isPlainObject(doc.labels.priority)) throw opError('backlog-groom profile: labels.priority must be an object');
      rejectUnknownKeys(doc.labels.priority, PRIORITY_KEYS, 'labels.priority');
      const seenLabels = new Set();
      for (const [band, label] of Object.entries(doc.labels.priority)) {
        if (typeof label !== 'string' || label.length === 0) {
          throw opError(`backlog-groom profile: labels.priority.${band} must be a non-empty string`);
        }
        // Two bands mapping to one label make a relabel proposal meaningless:
        // the "from" and the "to" would be the same string.
        if (seenLabels.has(label)) {
          throw opError(`backlog-groom profile: labels.priority maps more than one band to ${JSON.stringify(label)}`);
        }
        seenLabels.add(label);
      }
    }
    if (Object.hasOwn(doc.labels, 'areaPrefix')) {
      // An EMPTY prefix makes every label on an issue look like the area label,
      // so a proposal would name an unrelated label as the one to replace — and
      // a consumer applying it would overwrite something it was never about.
      if (typeof doc.labels.areaPrefix !== 'string' || doc.labels.areaPrefix.length === 0) {
        throw opError('backlog-groom profile: labels.areaPrefix must be a non-empty string');
      }
    }
  }

  if (Object.hasOwn(doc, 'providers')) {
    if (!isPlainObject(doc.providers)) throw opError('backlog-groom profile: providers must be an object');
    rejectUnknownKeys(doc.providers, PROVIDERS_KEYS, 'providers');
    for (const [role, name] of Object.entries(doc.providers)) {
      if (typeof name !== 'string' || name.length === 0) {
        throw opError(`backlog-groom profile: providers.${role} must be a non-empty string`);
      }
    }
  }

  for (const [key, label] of [['autonomyFloor', 'autonomyFloor'], ['units', 'units'], ['frozenPaths', 'frozenPaths']]) {
    if (Object.hasOwn(doc, key) && !Array.isArray(doc[key])) {
      throw opError(`backlog-groom profile: ${label} must be an array`);
    }
  }

  // Each UNIT is validated, not merely the array around it. Raised in
  // cross-model review: a `pathsx` typo was silently accepted, the unit matched
  // nothing, its issues quietly fell out of every cluster, and its area relabel
  // proposals were suppressed — while the run still looked entirely healthy.
  // That is precisely the silent-ineffectiveness the fail-closed rule exists to
  // prevent, so the check has to reach the same depth as the damage.
  if (Object.hasOwn(doc, 'units')) {
    doc.units.forEach((unit, i) => {
      if (!isPlainObject(unit)) throw opError(`backlog-groom profile: units[${i}] must be an object`);
      rejectUnknownKeys(unit, UNIT_KEYS, `units[${i}]`);
      if (typeof unit.name !== 'string' || unit.name.length === 0) {
        throw opError(`backlog-groom profile: units[${i}].name must be a non-empty string`);
      }
      if (!Array.isArray(unit.paths) || unit.paths.length === 0) {
        throw opError(`backlog-groom profile: units[${i}] (${unit.name}) must declare a non-empty paths array`);
      }
      for (const g of unit.paths) {
        if (typeof g !== 'string' || g.length === 0) {
          throw opError(`backlog-groom profile: units[${i}] (${unit.name}) has a non-string path glob`);
        }
      }
    });
  }

  for (const key of ['frozenPaths', 'autonomyFloor']) {
    if (!Object.hasOwn(doc, key)) continue;
    for (const [i, v] of doc[key].entries()) {
      if (typeof v !== 'string' || v.length === 0) {
        throw opError(`backlog-groom profile: ${key}[${i}] must be a non-empty string`);
      }
    }
  }

  const labels = Object.hasOwn(doc, 'labels')
    ? {
        priority: Object.hasOwn(doc.labels, 'priority') ? clone(doc.labels.priority) : clone(DEFAULT_PROFILE.labels.priority),
        areaPrefix: Object.hasOwn(doc.labels, 'areaPrefix') ? doc.labels.areaPrefix : DEFAULT_PROFILE.labels.areaPrefix,
      }
    : clone(DEFAULT_PROFILE.labels);

  return {
    schemaVersion: version,
    autonomyFloor: Object.hasOwn(doc, 'autonomyFloor') ? clone(doc.autonomyFloor) : clone(DEFAULT_PROFILE.autonomyFloor),
    units: Object.hasOwn(doc, 'units') ? clone(doc.units) : clone(DEFAULT_PROFILE.units),
    frozenPaths: Object.hasOwn(doc, 'frozenPaths') ? clone(doc.frozenPaths) : clone(DEFAULT_PROFILE.frozenPaths),
    labels,
    providers: Object.hasOwn(doc, 'providers') ? clone(doc.providers) : clone(DEFAULT_PROFILE.providers),
  };
}
