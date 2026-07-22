/**
 * @typedef {{ name: string, packageName: string, binName?: string, summary: string, external?: boolean }} Tool
 * @typedef {{ title: string, tools: Tool[] }} Group
 */
// `external: true` marks a verb that is not one of this monorepo's @adlc/* workspace
// packages. It dispatches via `npx <packageName>` instead of resolving a local bin
// (see runExternal in dispatch.mjs). `review` is the one example today: it routes to
// the separate `adversarial-review` CLI -- the actual model-judged reviewer that
// `@adlc/prosecute` records evidence *for* but never runs itself (see issue #65).

/** @type {Group[]} */
export const GROUPS = [
  {
    title: 'Spec and ticket shaping',
    tools: [
      { name: 'parallax', packageName: '@adlc/parallax', summary: 'Fan out readers to expose spec ambiguity and route conflicts.' },
      { name: 'spec-lint', packageName: '@adlc/spec-lint', summary: 'Gate specs for acceptance criteria that lack a verification method.' },
      { name: 'premortem', packageName: '@adlc/premortem', summary: 'Stress-test an approved spec before implementation.' },
      { name: 'coldstart', packageName: '@adlc/coldstart', summary: 'Check whether tickets are executable without agent guesswork.' },
      { name: 'ticket-prune', packageName: '@adlc/ticket-prune', summary: 'Report and archive stale, already-shipped tickets out of tickets.json.' },
    ],
  },
  {
    title: 'Execution supervision and rails',
    tools: [
      { name: 'preflight', packageName: '@adlc/preflight', summary: 'Check baseline environment readiness before fan-out.' },
      { name: 'model-router', packageName: '@adlc/model-router', summary: 'Assign tickets to frontier, direct, or ladder model strategies.' },
      { name: 'merge-forecast', packageName: '@adlc/merge-forecast', summary: 'Estimate fan-out width, dependency pressure, and merge backpressure.' },
      { name: 'rails-guard', packageName: '@adlc/rails-guard', summary: 'Enforce frozen rails, declared suppressions, and manifest recording.' },
      { name: 'build-gate', packageName: '@adlc/build-gate', summary: 'Deny starting a high-risk ticket build in a degraded (context-rot) session unless audited.' },
      { name: 'flail-detector', packageName: '@adlc/flail-detector', summary: 'Detect repeated errors, scope violations, edit churn, and oversized logs.' },
      { name: 'consensus-fix', packageName: '@adlc/consensus-fix', summary: 'Fan out candidate fixes and select the gated consensus winner.' },
      { name: 'fleet', packageName: '@adlc/fleet', binName: 'adlc-fleet', summary: 'Orchestrate parallel ticket execution — dispatch ready tickets to sandboxed workers, gate, prosecute, and merge to an integration branch.' },
    ],
  },
  {
    title: 'Review evidence and calibration',
    tools: [
      { name: 'behavior-diff', packageName: '@adlc/behavior-diff', summary: 'Capture and compare HTTP/API behavior snapshots for the P6 human gate.' },
      { name: 'gate-manifest', packageName: '@adlc/gate-manifest', summary: 'Record, verify, show, and attest append-only gate evidence.' },
      { name: 'spend', packageName: '@adlc/gate-manifest', binName: 'adlc-spend', summary: 'Aggregate recorded token usage into per-phase spend, the barbell shape, and the §6 diagnostics.' },
      { name: 'hollow-test', packageName: '@adlc/hollow-test', summary: 'Mutate changed code to find tests that pass without testing behavior.' },
      { name: 'prosecute', packageName: '@adlc/prosecute', binName: 'adlc-prosecute', summary: 'Record ticket- and revision-bound P5 prosecution evidence.' },
      { name: 'review-calibration', packageName: '@adlc/review-calibration', summary: 'Measure reviewer recall by scoring whether review catches mutants.' },
      { name: 'model-ratchet', packageName: '@adlc/model-ratchet', summary: 'Identify hot files for re-prosecution after model or repo drift.' },
      { name: 'gate-fuzzing', packageName: '@adlc/gate-fuzzing', summary: 'Run hostile candidates against gate suites to find defeats.' },
      { name: 'review', packageName: 'adversarial-review', external: true, summary: 'Run the model-judged adversarial review (via `npx adversarial-review`) that `prosecute` records evidence for.' },
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
      { name: 'init', packageName: '@adlc/init', binName: 'adlc-init', summary: 'Idempotently bootstrap .adlc state and project-scoped harness configuration.' },
      { name: 'ticket', packageName: '@adlc/tickets', binName: 'adlc-tickets', summary: 'Create, inspect, migrate, archive, and synchronize ADLC tickets.' },
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
