// trust-root-authorization.mjs — the PURE decision for the #141 trust-root change
// ceremony. A change to an immutable trust root is AUTHORIZED only when the PR
// carries the `trust-root-change` LABEL (explicit intent) AND a non-author
// CODEOWNER APPROVING review (the authorization — GitHub forbids self-approval,
// so an author cannot authorize their own trust-root change). Anything short of
// that fails closed. This function does NO I/O: the GitHub adapter gathers the
// label/review/owner inputs; keeping the decision pure makes it exhaustively
// unit-testable and keeps the security-critical logic out of network code.
//
// The script check this drives makes the `rails-guard` signal GREEN + AUDITED for
// authorized changes; the un-forgeable merge gate remains GitHub branch
// protection requiring CODEOWNERS review for the trust-root paths (a PR cannot
// tamper that, even by rewriting HEAD's workflow). See #141 / ADR-0007 context.

const normalizeLogin = (value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase();

// State-changing review states, in GitHub's model. COMMENTED and PENDING do NOT
// change a reviewer's approval standing, so they are ignored when computing the
// latest effective state; DISMISSED clears a prior approval.
const STATE_CHANGING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * @param {object} reviews  array of { user, state } in chronological order
 * @returns {Map<string, string>}  normalized login → latest effective state
 */
function latestEffectiveStates(reviews) {
  const byUser = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const state = String(review?.state ?? '').toUpperCase();
    if (!STATE_CHANGING.has(state)) continue; // comment/pending never overrides
    byUser.set(normalizeLogin(review.user), { user: review.user, state });
  }
  return byUser;
}

/**
 * Decide whether a trust-root change is authorized by the ceremony.
 *
 * @param {object} args
 * @param {string[]} [args.labels]       PR label names
 * @param {Array<{user:string,state:string}>} [args.reviews]  PR reviews (chronological)
 * @param {string} args.author           PR author login
 * @param {string[]} [args.owners]       CODEOWNERS logins for the changed trust-root paths
 * @param {string} [args.requiredLabel]  default 'trust-root-change'
 * @returns {{ authorized: boolean, approver: string|null, reason: string }}
 */
export function classifyTrustRootAuthorization({
  labels = [],
  reviews = [],
  author,
  owners = [],
  requiredLabel = 'trust-root-change',
} = {}) {
  const wantLabel = normalizeLogin(requiredLabel);
  const hasLabel = (Array.isArray(labels) ? labels : []).map(normalizeLogin).includes(wantLabel);
  if (!hasLabel) {
    return { authorized: false, approver: null, reason: `missing the "${requiredLabel}" label` };
  }

  const authorLc = normalizeLogin(author);
  const ownerSet = new Set((Array.isArray(owners) ? owners : []).map(normalizeLogin));
  if (ownerSet.size === 0) {
    return { authorized: false, approver: null, reason: 'no CODEOWNERS declared for the changed trust-root paths' };
  }

  for (const [login, { user, state }] of latestEffectiveStates(reviews)) {
    if (state !== 'APPROVED') continue;
    if (login === authorLc) continue;      // an author cannot authorize their own change
    if (!ownerSet.has(login)) continue;    // must be an owner of the trust-root paths
    return { authorized: true, approver: user, reason: `authorized by non-author CODEOWNER ${user}` };
  }
  return {
    authorized: false,
    approver: null,
    reason: 'no current approving review from a non-author trust-root CODEOWNER',
  };
}

// Minimal CODEOWNERS pattern matcher (gitignore-style), used both to resolve the OWNERS
// of a changed trust-root path and — since #140 — to answer COVERAGE ("does anyone own the
// deployed workflow?").
//
// Those two uses have OPPOSITE safety directions, which is what makes this function
// delicate. For owner resolution, over-matching only widens the owner set (an added owner
// must still produce a real approving review) and under-matching just denies. For COVERAGE,
// over-matching is a fail-OPEN: a path GitHub treats as ownerless gets reported as
// protected. So every rule below is written to the stricter reading.
//
// Supported: a leading `/` anchors to the repo root; `?` matches exactly one non-`/`
// character; `*` does not cross `/`; `**` crosses `/` ONLY when it is a whole slash-
// delimited segment (`**/x`, `a/**/b`, `a/**`) — elsewhere it degrades to `*`, per
// gitignore; a trailing `/` matches paths UNDER that directory and never the directory
// path itself; an un-anchored pattern also matches by basename.
//
// KNOWN LIMIT — this is deliberately NOT a complete gitignore implementation, and the
// remaining gaps all UNDER-match (character classes `[a-z]`, a bare unanchored `dir/`
// matching at any depth, `\` escapes). Under-matching fails CLOSED in both uses: coverage
// reports "ownerless" and refuses to enable, owner resolution drops an owner and denies.
// Widening it is tracked separately, because a more permissive matcher risks reintroducing
// exactly the over-match fail-opens this function has already had.
export function codeownersMatch(pattern, path) {
  let p = String(pattern ?? '');
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);

  // `?` and `*` are wildcards, not regex syntax. `?` in particular must CONSUME a
  // character: left unescaped it acted as a quantifier making the preceding character
  // optional, so `<workflow>?` matched `<workflow>` and falsely attested coverage.
  const segmentToRegex = (segment) => segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+|\?/g, (m) => (m === '?' ? '[^/]' : '[^/]*'));

  // Build per SEGMENT so `**` only crosses `/` where gitignore says it does. Treating any
  // `**` as `.*` let `.github**adlc-rails-guard.yml` match the workflow three directories
  // away — an over-match, and therefore a coverage fail-open.
  const segments = p.split('/');
  let rx = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      // Trailing `/**` is "everything below"; an interior or leading `**/` is "zero or
      // more directories", so the separator lives INSIDE the group and none is appended.
      rx += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    rx += segmentToRegex(segment);
    if (!last) rx += '/';
  });

  const re = new RegExp(dir ? `^${rx}/.*$` : `^${rx}$`);
  return re.test(path) || (!anchored && re.test(String(path ?? '').split('/').pop()));
}
