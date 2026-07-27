import Link from 'next/link';
import { TOOLKIT_GROUPS } from '@/lib/toolkit-packages.mjs';

export function Constellation() {
  return (
    <div className="flex flex-col gap-10">
      {TOOLKIT_GROUPS.map((g) => (
        <div key={g.group}>
          <div className="mb-4 flex items-baseline gap-4">
            <h3
              className="whitespace-nowrap rec-mono text-sm uppercase tracking-widest"
              style={{ color: 'var(--rec-ink-2)' }}
            >
              {g.group}
            </h3>
            <span aria-hidden className="h-px min-w-8 flex-1 self-center" style={{ background: 'var(--rec-rule)' }} />
            <span className="whitespace-nowrap rec-mono text-xs" style={{ color: 'var(--rec-ink-2)' }}>
              {g.packages.length} {g.packages.length === 1 ? 'package' : 'packages'}
            </span>
          </div>
          {/* A parts list, not a tag cloud: squared cells on the raised paper,
              because a pill is a control and these are line items. */}
          <div className="flex flex-wrap gap-px" style={{ background: 'var(--rec-rule)', border: '1px solid var(--rec-rule)' }}>
            {g.packages.map((name) => (
              <Link
                key={name}
                href={`/docs/toolkit/${name}`}
                className="rec-mono px-3.5 py-2 text-[13px] transition-colors hover:text-[var(--rec-link)]"
                style={{ background: 'var(--rec-paper-raised)', color: 'var(--rec-ink)' }}
              >
                {name}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
