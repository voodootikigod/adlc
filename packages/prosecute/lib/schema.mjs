const STATUSES = new Set(['verified', 'killed', 'needs-human']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const LENSES = new Set(['security', 'correctness', 'tests', 'behavior', 'integration', 'docs']);

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
    for (const [findingIndex, finding] of pass.findings.entries()) {
      errors.push(...validateFinding(finding, passIndex, findingIndex));
    }
  }
  return errors;
}
