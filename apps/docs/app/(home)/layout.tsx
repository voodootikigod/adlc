import Link from 'next/link';
import { Masthead, RecordFoot } from '@/components/marketing/record';
import { SERIES_BASE } from '@/lib/theory-links.mjs';

/**
 * The marketing routes are a controlled-change record, so they do not use the
 * Fumadocs HomeLayout: its nav, its chrome, and its card grammar belong to the
 * docs world. /docs keeps that layout and the dark reading surface. This layout
 * establishes the record surface and the masthead every marketing route shares.
 */
export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <div className="record-surface flex min-h-screen flex-col">
      <Masthead />
      <div className="flex-1">{children}</div>
      <RecordFoot>
        <span>
          ADLC began as an essay series.{' '}
          <a
            href={`${SERIES_BASE}/series/adlc`}
            style={{ color: 'var(--rec-link)', borderBottom: '1px solid var(--rec-link-edge)' }}
          >
            Read the original theory at voodootikigod.com ↗
          </a>
        </span>
        <span className="flex items-center gap-4">
          <span className="rec-mono">MIT · @adlc on npm</span>
          <Link href="/privacy" style={{ color: 'var(--rec-ink-3)' }} className="underline">
            Privacy
          </Link>
        </span>
      </RecordFoot>
    </div>
  );
}
