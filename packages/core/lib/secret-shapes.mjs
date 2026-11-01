// Credential shapes shared by the findings-ledger publish check (ledger.mjs) and
// the removed-line diff mask (diff-mask.mjs). Internal: not re-exported from
// index.mjs, so the pattern list is not public API.

// KNOWN provider credential shapes. This list is necessarily incomplete — new formats
// appear constantly — so it is a best-effort filter, NOT a proof of secret-freedom.
// The high-entropy catch below covers unlabelled random secrets the list misses, and
// the durable guarantee remains that findings are CURATED PROSE (ADR 0014), not a
// claim that this function catches every possible secret.
//
// The inline-assignment pattern captures its `name =` prefix in group 1 so a mask
// can keep the name and replace only the value; `.test()` callers ignore groups.
export const INLINE_ASSIGNMENT = /\b((?:api[-_]?key|secret|passwd|password|token|access[-_]?key)\b\s*[:=]\s*)\S{8,}/i;

export const SECRET_PATTERNS = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bASIA[0-9A-Z]{16}\b/, 'an AWS temporary access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, 'a GitHub fine-grained token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, 'a GitLab token'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, 'an OpenAI API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key block'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, 'a bearer token'],
  [INLINE_ASSIGNMENT, 'an inline credential assignment'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
];

// Shannon entropy (bits/char) of a token — high for random secrets, low for prose.
function tokenEntropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) { const p = n / s.length; bits -= p * Math.log2(p); }
  return bits;
}

// Splits text into the candidate tokens isRandomSecretToken judges.
export const TOKEN_SEPARATORS = /[\s"'`(){}\[\],:]+/;

// A long, high-entropy, mixed-case+digit run with no whitespace is almost certainly a
// key/token, not curated prose. Deliberately conservative — hex-only runs (git shas,
// hashes findings legitimately cite) are EXEMPT, so this does not fire on the ledger's
// own member keys or on quoted commit ids.
export function isRandomSecretToken(token) {
  if (token.length < 32) return false;
  // Pure hex up to a git-sha's 40 chars is exempt (a sha, a member key, a cluster
  // id — things findings legitimately cite). A LONGER pure-hex run is NOT a git sha;
  // treat it as a hex-encoded key or hash that belongs described, not quoted — the
  // exact 64-char-hex-in-`evidence` bypass an unbounded hex exemption allowed.
  if (/^[0-9a-f]{1,40}$/i.test(token)) return false;
  if (/^[0-9a-f]{41,}$/i.test(token)) return true;
  if (!/[a-z]/.test(token) || !/[A-Z0-9]/.test(token)) return false; // needs real mixing
  return tokenEntropy(token) >= 4.0;
}

export function looksLikeRandomSecret(text) {
  return String(text).split(TOKEN_SEPARATORS).some(isRandomSecretToken);
}
