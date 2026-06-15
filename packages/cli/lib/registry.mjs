// registry.mjs — the single source of truth for which @adlc tools the
// dispatcher knows about, grouped by ADLC lifecycle cluster.
//
// Each entry's `name` is BOTH the npm package suffix (@adlc/<name>) and the
// subcommand (`adlc <name>`) and the installed binary name — the contract
// guarantees those three are identical (see CONVENTIONS.md "CLI shape").
// Pure data + pure lookups; no I/O.

/**
 * @typedef {{ name: string, summary: string }} Tool
 * @typedef {{ title: string, tools: Tool[] }} Group
 */

/** @type {Group[]} */
export const GROUPS = [
  {
    title: 'Spec & ticket shaping',
    tools: [
      { name: 'parallax', summary: 'Fan out readers to expose spec ambiguity and route conflicts.' },
      { name: 'spec-lint', summary: 'Gate specs for acceptance criteria that lack a verification method.' },
      { name: 'premortem', summary: 'Stress-test an approved spec before implementation.' },
      { name: 'coldstart', summary: 'Check whether tickets are executable without agent guesswork.' },
    ],
  },
  {
    title: 'Execution supervision & rails',
    tools: [
      { name: 'preflight', summary: 'Check baseline environment readiness before fan-out.' },
      { name: 'model-router', summary: 'Assign tickets to frontier, direct, or ladder model strategies.' },
      { name: 'merge-forecast', summary: 'Estimate fan-out width, dependency pressure, and merge backpressure.' },
      { name: 'rails-guard', summary: 'Enforce frozen rails, declared suppressions, and manifest recording.' },
      { name: 'flail-detector', summary: 'Detect repeated errors, scope violations, edit churn, oversized logs.' },
      { name: 'consensus-fix', summary: 'Fan out candidate fixes and select the gated consensus winner.' },
    ],
  },
  {
    title: 'Review evidence & calibration',
    tools: [
      { name: 'behavior-diff', summary: 'Capture and compare HTTP/API behavior snapshots for the P6 human gate.' },
      { name: 'gate-manifest', summary: 'Record, verify, show, and attest append-only gate evidence.' },
      { name: 'hollow-test', summary: 'Mutate changed code to find tests that pass without testing behavior.' },
      { name: 'review-calibration', summary: 'Measure reviewer recall by scoring whether review catches mutants.' },
      { name: 'model-ratchet', summary: 'Identify hot files for re-prosecution after model or repo drift.' },
      { name: 'gate-fuzzing', summary: 'Run hostile candidates against gate suites to find defeats.' },
    ],
  },
  {
    title: 'Compounding defenses',
    tools: [
      { name: 'lesson-foundry', summary: 'Mine repeated findings into deterministic defenses (lint checks, skills).' },
      { name: 'rejection-mining', summary: 'Mine review rejections into reusable review lenses.' },
      { name: 'skill-rot', summary: 'Check skill files for stale validation metadata and stamp freshness.' },
    ],
  },
];

/** Flat list of every tool, in group order. @type {Tool[]} */
export const TOOLS = GROUPS.flatMap((g) => g.tools);

/** Set of valid tool names for O(1) membership checks. */
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/**
 * Is `name` a tool this dispatcher knows about?
 * @param {string} name
 * @returns {boolean}
 */
export function isTool(name) {
  return TOOL_NAMES.has(name);
}

/**
 * Suggest the closest known tool name for a typo, or null if nothing is close.
 * Uses a cheap edit-distance threshold — good enough for "did you mean".
 * @param {string} name
 * @returns {string | null}
 */
export function suggest(name) {
  let best = null;
  let bestDist = Infinity;
  for (const t of TOOLS) {
    const d = editDistance(name, t.name);
    if (d < bestDist) {
      bestDist = d;
      best = t.name;
    }
  }
  // Only suggest when the typo is plausibly the same word.
  return bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

/** Levenshtein distance. Small inputs; iterative two-row implementation. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
