import Link from 'next/link';
import { TOOLKIT_GROUPS } from '@/lib/toolkit-packages.mjs';

export function Constellation() {
  return (
    <div className="flex flex-col gap-10">
      {TOOLKIT_GROUPS.map((g) => (
        <div key={g.group}>
          <div className="mb-4 flex items-baseline gap-4">
            {/* h2, not h3: the page's h1 is the only heading above these, and a
                skipped level is a real hole in the outline a reader's screen
                reader walks. */}
            <h2 className="rec-mono text-sm uppercase tracking-widest" style={{ color: 'var(--rec-ink-2)' }}>
              {g.group}
            </h2>
            <span aria-hidden className="h-px min-w-8 flex-1 self-center" style={{ background: 'var(--rec-rule)' }} />
            <span className="whitespace-nowrap rec-mono text-xs" style={{ color: 'var(--rec-ink-2)' }}>
              {g.packages.length} {g.packages.length === 1 ? 'package' : 'packages'}
            </span>
          </div>
          {/* A parts list, not a tag cloud: squared cells on the raised paper,
              because a pill is a control and these are line items. Link ink on
              the names because they ARE links — a cell with no affordance reads
              as an inert label and never gets clicked. */}
          <div className="flex flex-wrap gap-px" style={{ background: 'var(--rec-rule)', border: '1px solid var(--rec-rule)' }}>
            {g.packages.map((name) => (
              <Link
                key={name}
                href={`/docs/toolkit/${name}`}
                className="rec-mono px-3.5 py-2 text-[13px] transition-colors hover:underline"
                style={{ background: 'var(--rec-paper-raised)', color: 'var(--rec-link)' }}
              >
                {name}
              </Link>
            ))}
            {/* Filler: absorbs the unfilled end of the last track as plain
                paper, so the lattice never shows a dead grey slab where the
                row runs short. */}
            <span aria-hidden className="min-w-8 flex-[999]" style={{ background: 'var(--rec-paper)' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
