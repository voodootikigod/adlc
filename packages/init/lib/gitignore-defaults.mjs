// Single-line array literal: the mutation gate's array-literal-shrink operator
// only matches a `[...]` that fits on one line, and this constant has no
// branches/comparisons an operator could otherwise catch a silent drop with.
//
// ORDER IS LOAD-BEARING — gitignore is last-match-wins. `.adlc/*` first, then
// every negation, then the re-ignores. The manifest entries close a real gap:
// without them a scaffolded repo keeps its C11 evidence ledger LOCAL-ONLY, so
// CI, clones, and reviewers see an empty ledger and rails-guard's append-only
// check has nothing committed to protect — and once forest mode is enabled the
// activation marker would be ignored too, silently diverging storage mode per
// checkout. `.lineage` and the lock files are re-ignored AFTER the `manifest.d`
// negations because they are checkout-local: a committed lineage token
// recreates the very merge conflict the segmented format exists to remove.
// `gate-manifest enable` enforces this same two-sided contract at activation.
export const ADLC_GITIGNORE_LINES = Object.freeze(['.adlc/*', '!.adlc/config.json', '!.adlc/tickets.json', '!.adlc/tickets/', '!.adlc/tickets/**', '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**', '!.adlc/specs/', '!.adlc/manifest.jsonl', '!.adlc/manifest.d/', '!.adlc/manifest.d/**', '.adlc/manifest.d/.lineage', '.adlc/manifest.d/*.lock']);
