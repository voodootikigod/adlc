// Single-line array literal: the mutation gate's array-literal-shrink operator
// only matches a `[...]` that fits on one line, and this constant has no
// branches/comparisons an operator could otherwise catch a silent drop with.
export const ADLC_GITIGNORE_LINES = Object.freeze(['.adlc/*', '!.adlc/config.json', '!.adlc/tickets.json', '!.adlc/tickets/', '!.adlc/tickets/**', '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**', '!.adlc/specs/']);
