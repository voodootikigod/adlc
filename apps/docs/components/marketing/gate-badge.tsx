// FAIL text uses the AA-contrast token; its border/background keep the base
// gate token (non-text, 3:1 suffices — the glyph + label carry the state).
const STATES = {
  pass: { glyph: '✓', label: 'PASS', color: 'var(--adlc-pass)', accent: 'var(--adlc-pass)' },
  fail: { glyph: '✗', label: 'FAIL', color: 'var(--mk-fail-text)', accent: 'var(--adlc-fail)' },
  wish: { glyph: '◌', label: 'WISH', color: 'var(--adlc-wish)', accent: 'var(--adlc-wish)' },
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
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-0.5 font-mono text-xs font-bold tracking-wider"
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
