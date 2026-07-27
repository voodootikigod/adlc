// `gate` is the exit gate that ENDS each phase, quoted from the canonical
// pipeline in ADLC.md (the "human gate / cold-start / RED gate / green gate /
// zero-findings gate" line under the P0→P7 flow). It lives here rather than in
// a component so the homepage pipeline and the /lifecycle page cannot disagree
// about what gate closes a phase — they previously each carried their own idea
// of which gates were human.
//
// `human: true` marks the two phases a person must close. That pair is the
// whole claim: machines gate the other six.
export const PHASES = [
  { id: 'P0', name: 'Triage', gate: 'routed', human: false },
  { id: 'P1', name: 'Interrogate', gate: 'human gate', human: true },
  { id: 'P2', name: 'Decompose', gate: 'cold-start', human: false },
  { id: 'P3', name: 'Rail', gate: 'RED gate', human: false },
  { id: 'P4', name: 'Build', gate: 'green gate', human: false },
  { id: 'P5', name: 'Prosecute', gate: 'zero findings', human: false },
  { id: 'P6', name: 'Integrate', gate: 'human gate', human: true },
  { id: 'P7', name: 'Distill', gate: 'feeds the next run', human: false },
];

/** The two phases whose gate is a person, derived so no surface can drift. */
export const HUMAN_GATE_IDS = PHASES.filter((p) => p.human).map((p) => p.id);

// Mermaid cannot resolve CSS variables, so these hexes are hardcoded.
// #e5cd52 mirrors --adlc-wish (human-gate styling); #4fb4d8 mirrors the
// primary --color-fd-primary (active-phase highlight). Keep them in sync
// with app/global.css.
const GATE_FILL = '#e5cd52';
const ACTIVE_FILL = '#4fb4d8';
const DARK_TEXT = '#1c1d21';

export function buildPhaseMermaid(active) {
  if (!PHASES.some((p) => p.id === active)) {
    throw new Error(`unknown phase: ${active}`);
  }
  const byId = Object.fromEntries(PHASES.map((p) => [p.id, p]));
  const node = (id) => `  ${id}["${id} ${byId[id].name}"]`;
  const lines = [
    'flowchart TD',
    node('P0'),
    node('P1'),
    // The two human gates — hexagon nodes so they read differently from phases.
    '  G1{{"Human gate: Is this what I meant?"}}',
    node('P2'),
    node('P3'),
    node('P4'),
    node('P5'),
    node('P6'),
    '  G2{{"Human gate: Is this what I meant, running?"}}',
    node('P7'),
    '  P0 --> P1',
    '  P1 --> G1',
    '  G1 --> P2',
    '  P2 --> P3',
    '  P3 --> P4',
    '  P4 --> P5',
    '  P5 -- "loop until dry" --> P5',
    '  P5 --> P6',
    '  P6 --> G2',
    '  G2 --> P7',
    '  P7 -. "lessons compound" .-> P0',
    `  style G1 fill:${GATE_FILL},stroke:${GATE_FILL},color:${DARK_TEXT}`,
    `  style G2 fill:${GATE_FILL},stroke:${GATE_FILL},color:${DARK_TEXT}`,
    // Active-phase highlight stays primary blue so it never blends with the
    // wish-yellow gate styling above.
    `  style ${active} fill:${ACTIVE_FILL},stroke:#cbcdd2,color:${DARK_TEXT}`,
  ];
  return lines.join('\n');
}
