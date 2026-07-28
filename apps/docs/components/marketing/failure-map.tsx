import Link from 'next/link';
import { FAILURE_MODES } from '@/lib/failure-modes.mjs';

// F1–F8 and the gate that defends each — the core ADLC claim (every defense
// traces to a failure mode) made visual.
//
// This used to be a lattice of cells joined by a rail-and-ring SVG connector,
// borrowed from a pipeline diagram that no longer exists. Under the record the
// relationship is a register: fixed columns, one row per mode, the defending
// gate in the column reserved for it. The mapping is legible by alignment, so
// the connector was drawing a line the columns already draw.
export function FailureMap() {
  return (
    <div style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
      <div
        className="hidden grid-cols-[46px_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.9fr)] md:grid"
        style={{ background: 'var(--rec-paper-sunk)', borderBottom: '1px solid var(--rec-rule-strong)' }}
      >
        <div className="rec-legend px-3 py-2.5" />
        <div className="rec-legend px-3 py-2.5">Failure mode</div>
        <div className="rec-legend px-3 py-2.5">How it shows up</div>
        <div className="rec-legend px-3 py-2.5">Defended by</div>
      </div>

      <ul aria-label="Eight model failure modes F1 through F8, each mapped to the machine-checkable gate that defends against it">
        {Object.entries(FAILURE_MODES).map(([id, fm]) => (
          <li
            key={id}
            className="grid grid-cols-[46px_minmax(0,1fr)] gap-y-1 md:grid-cols-[46px_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.9fr)] md:gap-y-0"
            style={{ borderBottom: '1px solid var(--rec-rule)', background: 'var(--rec-paper-raised)' }}
          >
            <div className="rec-mono px-3 py-3 text-[12px]" style={{ color: '#a24e15' }}>
              {id}
            </div>
            <div className="px-3 py-3 text-[14.5px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
              {fm.name}
            </div>
            <div
              className="col-start-2 px-3 pb-1 text-[13.5px] leading-[1.5] md:col-start-auto md:py-3 md:pb-3"
              style={{ color: 'var(--rec-ink-2)' }}
            >
              {fm.tagline}
            </div>
            <div className="col-start-2 px-3 pb-3 md:col-start-auto md:py-3">
              <Link
                href={`/docs/toolkit/${fm.defense.tool}`}
                className="rec-mono text-[13px] font-semibold"
                style={{ color: 'var(--rec-link)', borderBottom: '1px solid var(--rec-link-edge)' }}
              >
                {fm.defense.tool}
              </Link>
              <span className="rec-mono ml-2 text-[12px]" style={{ color: 'var(--rec-ink-3)' }}>
                at {fm.defense.phase}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
