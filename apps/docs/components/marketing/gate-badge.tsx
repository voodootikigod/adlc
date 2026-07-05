const STATES = {
  pass: { glyph: '✓', label: 'PASS', color: 'var(--adlc-pass)' },
  fail: { glyph: '✗', label: 'FAIL', color: 'var(--adlc-fail)' },
  wish: { glyph: '◌', label: 'WISH', color: 'var(--adlc-wish)' },
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
        borderColor: `color-mix(in srgb, ${s.color} 55%, transparent)`,
        background: `color-mix(in srgb, ${s.color} 8%, transparent)`,
      }}
    >
      <span aria-hidden>{s.glyph}</span>
      {label ?? s.label}
    </span>
  );
}
