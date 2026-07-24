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

// Minimal CODEOWNERS pattern matcher (gitignore-style), used to resolve the
// owners of a changed trust-root path. A leading `/` anchors to the repo root;
// `*` does not cross `/`; `**` crosses; a trailing `/` matches a directory
// subtree; an un-anchored pattern also matches by basename (CODEOWNERS
// semantics). Over-matching only WIDENS the owner set — an added owner must
// still produce a real approving review — while under-matching removes owners
// and denies, so both directions fail safe for authorization.
export function codeownersMatch(pattern, path) {
  let p = String(pattern ?? '');
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);
  const rx = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'));
  const re = new RegExp(dir ? `^${rx}(?:/.*)?$` : `^${rx}$`);
  return re.test(path) || (!anchored && re.test(String(path ?? '').split('/').pop()));
}
