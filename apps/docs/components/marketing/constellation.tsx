import Link from 'next/link';
import { TOOLKIT_GROUPS } from '@/lib/toolkit-packages.mjs';

export function Constellation() {
  return (
    <div className="flex flex-col gap-10">
      {TOOLKIT_GROUPS.map((g) => (
        <div key={g.group}>
          <div className="mb-4 flex items-baseline gap-4">
            <h3
              className="whitespace-nowrap font-mono text-sm uppercase tracking-widest"
              style={{ color: 'var(--mk-muted)' }}
            >
              {g.group}
            </h3>
            <span aria-hidden className="h-px min-w-8 flex-1 self-center" style={{ background: '#3f4044' }} />
            <span className="whitespace-nowrap font-mono text-xs" style={{ color: 'var(--mk-muted)' }}>
              {g.packages.length} {g.packages.length === 1 ? 'package' : 'packages'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {g.packages.map((name) => (
              <Link
                key={name}
                href={`/docs/toolkit/${name}`}
                className="rounded-full border px-4 py-1.5 font-mono text-sm transition-colors hover:border-[#4fb4d8] hover:text-[#4fb4d8]"
                style={{ borderColor: '#3f4044', color: '#cbcdd2' }}
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
