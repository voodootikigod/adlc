import { MarketingSection } from './section';
import { InstallCommand } from './install-command';
import { RecordLink } from './record';
import { UNIVERSAL_INSTALL } from '@/lib/install-commands.mjs';

/**
 * The closing clause of an interior route: the record's executable field.
 *
 * Success for this site is an install, and four routes used to end on an
 * offsite essay link with no install path anywhere on the page — the peak-end
 * spent on a bounce. Every interior route now closes the way the record does,
 * with the IMPLEMENTATION field. One component so the wording cannot drift
 * per page.
 */
export function ImplementClause({ n }: { n: string }) {
  return (
    <MarketingSection n={n} kicker="Implement" title="Run it against your own repository">
      <div className="lg:max-w-[72ch]">
        <InstallCommand command={UNIVERSAL_INSTALL} />
      </div>
      <p className="mt-3 max-w-[72ch] text-[13px] leading-[1.55]" style={{ color: 'var(--rec-ink-3)' }}>
        macOS and Linux, Node 18+. Then{' '}
        <code className="rec-mono" style={{ color: 'var(--rec-ink)' }}>
          adlc init
        </code>{' '}
        in your repository. Windows is not supported.{' '}
        <RecordLink href="/integrations">Every install channel →</RecordLink>
      </p>
    </MarketingSection>
  );
}
