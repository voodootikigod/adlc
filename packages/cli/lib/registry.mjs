/**
 * @typedef {{ name: string, packageName: string, binName?: string, summary: string }} Tool
 * @typedef {{ title: string, tools: Tool[] }} Group
 */

/** @type {Group[]} */
export const GROUPS = [
  {
    title: 'Spec and ticket shaping',
    tools: [
      { name: 'parallax', packageName: '@adlc/parallax', summary: 'Fan out readers to expose spec ambiguity and route conflicts.' },
      { name: 'spec-lint', packageName: '@adlc/spec-lint', summary: 'Gate specs for acceptance criteria that lack a verification method.' },
      { name: 'premortem', packageName: '@adlc/premortem', summary: 'Stress-test an approved spec before implementation.' },
      { name: 'coldstart', packageName: '@adlc/coldstart', summary: 'Check whether tickets are executable without agent guesswork.' },
    ],
  },
  {
    title: 'Execution supervision and rails',
    tools: [
      { name: 'preflight', packageName: '@adlc/preflight', summary: 'Check baseline environment readiness before fan-out.' },
      { name: 'model-router', packageName: '@adlc/model-router', summary: 'Assign tickets to frontier, direct, or ladder model strategies.' },
      { name: 'merge-forecast', packageName: '@adlc/merge-forecast', summary: 'Estimate fan-out width, dependency pressure, and merge backpressure.' },
      { name: 'rails-guard', packageName: '@adlc/rails-guard', summary: 'Enforce frozen rails, declared suppressions, and manifest recording.' },
      { name: 'flail-detector', packageName: '@adlc/flail-detector', summary: 'Detect repeated errors, scope violations, edit churn, and oversized logs.' },
      { name: 'consensus-fix', packageName: '@adlc/consensus-fix', summary: 'Fan out candidate fixes and select the gated consensus winner.' },
    ],
  },
  {
    title: 'Review evidence and calibration',
    tools: [
      { name: 'behavior-diff', packageName: '@adlc/behavior-diff', summary: 'Capture and compare HTTP/API behavior snapshots for the P6 human gate.' },
      { name: 'gate-manifest', packageName: '@adlc/gate-manifest', summary: 'Record, verify, show, and attest append-only gate evidence.' },
      { name: 'hollow-test', packageName: '@adlc/hollow-test', summary: 'Mutate changed code to find tests that pass without testing behavior.' },
      { name: 'prosecute', packageName: '@adlc/prosecute', binName: 'adlc-prosecute', summary: 'Record ticket- and revision-bound P5 prosecution evidence.' },
      { name: 'review-calibration', packageName: '@adlc/review-calibration', summary: 'Measure reviewer recall by scoring whether review catches mutants.' },
      { name: 'model-ratchet', packageName: '@adlc/model-ratchet', summary: 'Identify hot files for re-prosecution after model or repo drift.' },
      { name: 'gate-fuzzing', packageName: '@adlc/gate-fuzzing', summary: 'Run hostile candidates against gate suites to find defeats.' },
    ],
  },
  {
    title: 'Compounding defenses',
    tools: [
      { name: 'lesson-foundry', packageName: '@adlc/lesson-foundry', summary: 'Mine repeated findings into deterministic defenses.' },
      { name: 'rejection-mining', packageName: '@adlc/rejection-mining', summary: 'Mine review rejections into reusable review lenses.' },
      { name: 'skill-rot', packageName: '@adlc/skill-rot', summary: 'Check skill files for stale validation metadata and stamp freshness.' },
    ],
  },
  {
    title: 'External integration',
    tools: [
      { name: 'ticket', packageName: '@adlc/ticket-sync', binName: 'adlc-ticket-sync', summary: 'Two-way sync ADLC tickets with external trackers (GitHub Issues).' },
    ],
  },
];

/** @type {Tool[]} */
export const TOOLS = GROUPS.flatMap((group) => group.tools);

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name) {
  return TOOL_BY_NAME.get(name) ?? null;
}

export function isTool(name) {
  return TOOL_BY_NAME.has(name);
}

export function suggest(name) {
  let best = null;
  let bestDist = Infinity;
  for (const tool of TOOLS) {
    const dist = editDistance(name, tool.name);
    if (dist < bestDist) {
      best = tool.name;
      bestDist = dist;
    }
  }
  return bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}
