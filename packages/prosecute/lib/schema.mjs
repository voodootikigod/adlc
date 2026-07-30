const STATUSES = new Set(['verified', 'killed', 'needs-human']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
// Core prosecutor lenses (correctness/security/contract/diff/tests) plus legacy
// recorder vocabulary kept for existing evidence packets.
const LENSES = new Set([
  'security',
  'correctness',
  'tests',
  'contract',
  'diff',
  'behavior',
  'integration',
  'docs',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLine(value) {
  return Number.isInteger(value) && value >= 0;
}

function isConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateProof(value, prefix, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${prefix} must be an object`];
  }
  const errors = [];
  for (const field of fields) {
    if (!isNonEmptyString(value[field])) errors.push(`${prefix}.${field} must be a non-empty string`);
  }
  return errors;
}

/**
 * Token-counter field names, verbatim from `gate-manifest/lib/spend.mjs` — the
 * READ side, and a rail. `aggregateSpend` sums exactly these keys, so a packet
 * that spells one of them differently records spend nothing ever counts. They
 * are restated here rather than imported because prosecute must not take a
 * dependency on the reader to validate the writer.
 */
const USAGE_COUNTERS = Object.freeze(['inputTokens', 'outputTokens', 'cachedTokens']);
/** Descriptive siblings spend.mjs carries alongside the counters (§8a). */
const USAGE_LABELS = Object.freeze(['provider', 'model', 'tier']);

function isTokenCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Validate an OPTIONAL per-pass `usage` block (§8a).
 *
 * Absent usage is valid and means "nothing was reported" — the no-fabrication
 * rule. What is rejected is a usage block that is PRESENT but unusable, because
 * silently dropping a malformed one would under-report spend while looking
 * healthy. A counter must be a non-negative integer: a float or a negative would
 * corrupt every downstream sum, and `aggregateSpend` coerces absent counters to
 * 0 rather than validating, so this is the only place it can be caught.
 */
export function validateUsage(usage, prefix) {
  if (usage === undefined) return [];
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return [`${prefix}.usage must be an object when present`];
  }
  const errors = [];
  // ALL THREE counters are required, not "at least one" (adversarial-review,
  // no-fabrication). `aggregateSpend` coerces an absent counter with `?? 0`, so
  // accepting a partial block silently converts UNKNOWN output/cache spend into
  // MEASURED ZERO — the very collapse the no-fabrication rule exists to prevent,
  // and the same standard the P4 adapters already hold (normalizeUsage rejects
  // a usage block unless every counter is a clean count). A version-skewed
  // serializer that drops a field must be rejected, not silently zeroed.
  for (const key of USAGE_COUNTERS) {
    if (usage[key] === undefined) {
      errors.push(`${prefix}.usage.${key} is required — a partial usage block would record unknown spend as measured zero`);
    } else if (!isTokenCount(usage[key])) {
      errors.push(`${prefix}.usage.${key} must be a non-negative integer`);
    }
  }
  for (const key of USAGE_LABELS) {
    if (usage[key] !== undefined && !isNonEmptyString(usage[key])) {
      errors.push(`${prefix}.usage.${key} must be a non-empty string when present`);
    }
  }
  for (const key of Object.keys(usage)) {
    if (!USAGE_COUNTERS.includes(key) && !USAGE_LABELS.includes(key)) {
      errors.push(`${prefix}.usage.${key} is not a recognized usage field`);
    }
  }
  return errors;
}

/**
 * Non-fatal diagnostics about a packet's usage blocks (§8a).
 *
 * A usage-bearing pass with no `callId` is VALID — the ticket is explicit that
 * such a packet "records usage as usual but is not retry-safe" — but silence
 * would be the wrong kind of valid: the carrier cannot be deduplicated, so an
 * ordinary operator rerun after a crash appends a SECOND carrier and quietly
 * doubles that call's spend. The operator gets told, because the alternative is
 * discovering it as an unexplained spike in a phase total weeks later.
 */
export function usageWarnings(input) {
  const passes = Array.isArray(input?.passes) ? input.passes : [];
  const warnings = [];
  for (const [index, pass] of passes.entries()) {
    if (pass?.usage === undefined) continue;
    const hasCallId = typeof pass.callId === 'string' && pass.callId.trim().length > 0;
    if (!hasCallId) {
      warnings.push(
        `pass ${index + 1}: usage is recorded but carries no callId — this carrier cannot be `
        + 'deduplicated, so re-running this packet after a crash or an operator rerun will append '
        + 'a SECOND carrier and double this call in the phase totals. Supply a stable callId to '
        + 'make the recording retry-safe.'
      );
    }
  }
  return warnings;
}

export function validateFinding(finding, passIndex, findingIndex) {
  const prefix = `pass ${passIndex + 1} finding ${findingIndex + 1}`;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return [`${prefix}: finding must be an object`];
  }

  const errors = [];
  for (const field of ['id', 'category', 'file', 'evidence', 'claim', 'recommendation']) {
    if (!isNonEmptyString(finding[field])) errors.push(`${prefix}: ${field} must be a non-empty string`);
  }
  if (!SEVERITIES.has(finding.severity)) {
    errors.push(`${prefix}: severity must be one of ${Array.from(SEVERITIES).join(', ')}`);
  }
  if (!isLine(finding.line_start)) errors.push(`${prefix}: line_start must be an integer >= 0`);
  if (!isLine(finding.line_end)) errors.push(`${prefix}: line_end must be an integer >= 0`);
  if (isLine(finding.line_start) && isLine(finding.line_end) && finding.line_end < finding.line_start) {
    errors.push(`${prefix}: line_end must be >= line_start`);
  }
  if (!isConfidence(finding.confidence)) errors.push(`${prefix}: confidence must be a number from 0 to 1`);
  if (!STATUSES.has(finding.verified_status)) {
    errors.push(`${prefix}: verified_status must be one of ${Array.from(STATUSES).join(', ')}`);
  }
  if (finding.verified_status === 'killed') {
    errors.push(...validateProof(finding.verification, `${prefix}: verification`, ['reason', 'method', 'evidence']));
  }
  return errors;
}

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['input must be a JSON object'];
  }
  if (!Array.isArray(input.passes)) return ['passes must be an array'];
  if (input.passes.length === 0) return ['passes must contain at least one pass'];

  const errors = [];
  errors.push(...validateProof(input.provenance, 'provenance', ['reviewer', 'session', 'command', 'transcript']));
  errors.push(...validateProof(input.review_packet, 'review_packet', [
    'prompt',
    'prompt_hash',
    'inputs',
    'inputs_hash',
    'clean_worktree',
  ]));
  const findings = input.passes.flatMap((pass) => (Array.isArray(pass?.findings) ? pass.findings : []));
  if (!findings.some((finding) => finding?.verified_status === 'verified')) {
    errors.push(...validateProof(input.no_findings_attestation, 'no_findings_attestation', [
      'reason',
      'method',
      'evidence',
    ]));
  }
  for (const [passIndex, pass] of input.passes.entries()) {
    if (!pass || typeof pass !== 'object' || Array.isArray(pass)) {
      errors.push(`pass ${passIndex + 1}: pass must be an object`);
      continue;
    }
    if (!LENSES.has(pass.lens)) {
      errors.push(`pass ${passIndex + 1}: lens must be one of ${Array.from(LENSES).join(', ')}`);
    }
    if (!Array.isArray(pass.findings)) {
      errors.push(`pass ${passIndex + 1}: findings must be an array`);
      continue;
    }
    if (pass.findings.length === 0 && !isNonEmptyString(pass.dry_evidence)) {
      errors.push(`pass ${passIndex + 1}: dry_evidence must be a non-empty string when findings is empty`);
    }
    errors.push(...validateUsage(pass.usage, `pass ${passIndex + 1}`));
    // `callId` is what makes the usage carrier retry-safe: it identifies the
    // external model call, so re-running an unchanged packet can recognise the
    // spend it already recorded instead of appending it twice. A packet without
    // one still records, but cannot be deduplicated — so it is a warning, not an
    // error (rejecting it would refuse honest spend from a caller that simply
    // has no stable id to offer).
    if (pass.callId !== undefined && !isNonEmptyString(pass.callId)) {
      errors.push(`pass ${passIndex + 1}: callId must be a non-empty string when present`);
    }
    for (const [findingIndex, finding] of pass.findings.entries()) {
      errors.push(...validateFinding(finding, passIndex, findingIndex));
    }
  }
  return errors;
}
