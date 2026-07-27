// FAIL text uses the AA-contrast token; its border/background keep the base
// gate token (non-text, 3:1 suffices — the glyph + label carry the state).
const STATES = {
  pass: { glyph: '✓', label: 'PASS', color: 'var(--rec-pass-ink)', accent: 'var(--rec-pass-ink)' },
  fail: { glyph: '✗', label: 'FAIL', color: 'var(--rec-fail-ink)', accent: 'var(--rec-fail-ink)' },
  // Labelled ATTEST, not WISH. "Attestation" is fixed product terminology;
  // "wish" is the internal name of the colour token and had leaked out as a
  // verdict word, so the same human gate read as ATTEST in the approval chain
  // and WISH here — two words for the load-bearing concept.
  wish: { glyph: '◆', label: 'ATTEST', color: 'var(--rec-gate-ink)', accent: 'var(--rec-gate-ink)' },
} as const;

export type GateState = keyof typeof STATES;

interface GateBadgeProps {
  state: GateState;
  label?: string;
}

// Accessibility rule (spec §4): gate state is always glyph + text, never color alone.
export function GateBadge({ state, label }: GateBadgeProps) {
  const s = STATES[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-0.5 rec-mono text-xs font-bold tracking-wider"
      style={{
        color: s.color,
        borderColor: `color-mix(in srgb, ${s.accent} 55%, transparent)`,
        background: `color-mix(in srgb, ${s.accent} 8%, transparent)`,
      }}
    >
      <span aria-hidden>{s.glyph}</span>
      {label ?? s.label}
    </span>
  );
}
