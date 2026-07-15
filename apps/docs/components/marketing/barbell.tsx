// Relative spend by phase — schematic, not to scale. The barbell is the
// series' economic argument: heavy at the ends (interrogate, prosecute,
// distill), light in the middle (build) — inverted from the SDLC because
// misbuilding is expensive and building is cheap.
const BARS = [
  { label: 'Interrogate', phase: 'P1', height: '100%', heavy: true },
  { label: 'Build', phase: 'P4', height: '28%', heavy: false },
  { label: 'Prosecute · Distill', phase: 'P5 · P7', height: '100%', heavy: true },
];

export function Barbell() {
  return (
    <figure>
      <div className="flex h-44 items-end gap-6" aria-hidden>
        {BARS.map((bar) => (
          <div key={bar.label} className="flex h-full flex-1 flex-col justify-end">
            <div
              className="rounded-t"
              style={{
                height: bar.height,
                background: bar.heavy ? '#4fb4d8' : 'rgba(79,180,216,0.25)',
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-6">
        {BARS.map((bar) => (
          <div key={bar.label} className="flex-1 text-center">
            <p className="text-sm font-medium" style={{ color: '#cbcdd2' }}>
              {bar.label}
            </p>
            <p className="font-mono text-xs" style={{ color: 'var(--mk-muted)' }}>
              {bar.phase}
            </p>
          </div>
        ))}
      </div>
      <figcaption className="mt-4 text-sm" style={{ color: 'var(--mk-muted)' }}>
        Relative spend by phase: heavy at the ends, light in the middle.
        Schematic, not to scale.
      </figcaption>
    </figure>
  );
}
