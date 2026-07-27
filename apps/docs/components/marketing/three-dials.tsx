const DIALS = [
  { name: 'Autonomy', value: 0.7, note: 'How long the agent runs unsupervised' },
  { name: 'Oversight', value: 0.5, note: 'How much of the output humans gate' },
  { name: 'Scope', value: 0.35, note: 'How much surface one ticket may touch' },
] as const;

// The three dials, as the record writes a setting: a named field, the value it
// was set to, and a ruled scale showing where in its range that sits.
//
// These were semicircle needle gauges. That is instrument-panel vocabulary —
// the world explicitly rejected for this product as too whimsical for the
// audience — and it had survived into the record by being re-tinted rather than
// rebuilt. A setting on a form is a value in a range, not a cockpit.
//
// The values are illustrative defaults for a worked example, which is why the
// header says so rather than implying a measured reading.
function DialRow({ name, value, note }: (typeof DIALS)[number]) {
  const pct = Math.round(value * 100);
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_64px] items-baseline gap-x-5 gap-y-2 px-2 py-4 md:grid-cols-[150px_minmax(0,1fr)_64px]"
      style={{ borderBottom: '1px solid var(--rec-rule)', background: 'var(--rec-paper-raised)' }}
    >
      <div className="text-[15px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
        {name}
      </div>

      {/* The scale: a ruled track with quarter ticks and a filled span. */}
      <div className="col-span-2 md:col-span-1">
        <div className="relative h-[18px]" style={{ borderBottom: '1px solid var(--rec-rule-strong)' }}>
          <div
            className="absolute bottom-0 left-0 top-[5px]"
            style={{ width: `${pct}%`, background: 'var(--rec-ink)' }}
          />
          {[0, 25, 50, 75, 100].map((t) => (
            <span
              key={t}
              aria-hidden
              className="absolute bottom-0 h-[6px] w-px"
              style={{ left: `calc(${t}% - ${t === 100 ? 1 : 0}px)`, background: 'var(--rec-rule-strong)' }}
            />
          ))}
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.45]" style={{ color: 'var(--rec-ink-2)' }}>
          {note}
        </p>
      </div>

      <div
        className="rec-mono text-right text-[14px] font-semibold tabular-nums"
        style={{ color: 'var(--rec-ink)' }}
      >
        {pct}%
      </div>
    </div>
  );
}

export function ThreeDials() {
  return (
    <div style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
      <div
        className="flex items-baseline justify-between px-2 py-2.5"
        style={{ background: 'var(--rec-paper-sunk)', borderBottom: '1px solid var(--rec-rule-strong)' }}
      >
        <span className="rec-legend">Dial · setting · range</span>
        <span className="rec-legend">Illustrative settings</span>
      </div>
      {DIALS.map((d) => (
        <DialRow key={d.name} {...d} />
      ))}
    </div>
  );
}
