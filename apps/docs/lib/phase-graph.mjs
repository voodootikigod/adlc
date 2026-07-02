export const PHASES = [
  { id: 'P0', name: 'Triage' },
  { id: 'P1', name: 'Interrogate' },
  { id: 'P2', name: 'Decompose' },
  { id: 'P3', name: 'Rail' },
  { id: 'P4', name: 'Build' },
  { id: 'P5', name: 'Prosecute' },
  { id: 'P6', name: 'Review' },
  { id: 'P7', name: 'Distill' },
];

export function buildPhaseMermaid(active) {
  if (!PHASES.some((p) => p.id === active)) {
    throw new Error(`unknown phase: ${active}`);
  }
  const nodes = PHASES.map((p) => `  ${p.id}["${p.id} ${p.name}"]`).join('\n');
  const edges = PHASES.slice(1)
    .map((p, i) => `  ${PHASES[i].id} --> ${p.id}`)
    .join('\n');
  const style = `  style ${active} fill:#4fb4d8,stroke:#cbcdd2,color:#1c1d21`;
  return `flowchart TD\n${nodes}\n${edges}\n${style}`;
}
