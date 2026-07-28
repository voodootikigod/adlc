import type { ReactNode } from 'react';

interface MarketingSectionProps {
  id?: string;
  /** The clause label, e.g. "Scope". Rendered in the record's left gutter. */
  kicker?: string;
  /** Clause number. Interior pages number their clauses like any record. */
  n?: string;
  title: string;
  // Interior pages pass 1 for their lead section so every page has exactly
  // one h1; visual treatment is identical either way.
  headingLevel?: 1 | 2;
  children: ReactNode;
}

/**
 * A clause of the record.
 *
 * Every marketing section is one, so the interior pages read as continuations of
 * the same document rather than as a different site: ruled column, a numbered
 * label in the left gutter, and the content in the measure beside it. The old
 * kicker-over-heading stack is gone — a tracked eyebrow above every section is
 * grammar nobody chose, whereas a clause label is the form's own.
 */
export function MarketingSection({ id, kicker, n, title, headingLevel = 2, children }: MarketingSectionProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const lead = headingLevel === 1;

  return (
    <section
      id={id}
      className="mx-auto w-full max-w-[1180px] scroll-mt-24"
      style={{
        borderLeft: '1px solid var(--rec-rule)',
        borderRight: '1px solid var(--rec-rule)',
        borderBottom: '1px solid var(--rec-rule)',
      }}
    >
      <div className="flex flex-col gap-x-6 px-6 pb-10 pt-10 md:flex-row md:px-8 md:pb-12 md:pt-12">
        {kicker ? (
          // mb-4 over the heading vs mt-3 under it: a heading keeps more space
          // above than below, including where the gutter stacks at mobile width.
          <div className="mb-4 shrink-0 md:mb-0 md:w-[104px] md:pt-1">
            {/* No whitespace-nowrap: interior kickers run long ("Claude Code
                integration") and a non-wrapping legend overflows the 104px
                gutter straight across the heading beside it. */}
            <div className="rec-legend leading-[1.5]">
              {n ? `§${n} ` : ''}
              {kicker}
            </div>
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <Heading
            className={
              lead
                ? 'rec-statement max-w-[26ch] text-balance text-[clamp(28px,3.8vw,46px)] font-bold'
                : 'max-w-[34ch] text-balance text-[clamp(19px,2.1vw,26px)] font-bold tracking-[-0.018em]'
            }
            style={{ color: 'var(--rec-ink)' }}
          >
            {title}
          </Heading>
          <div className="mt-3 md:mt-7">{children}</div>
        </div>
      </div>
    </section>
  );
}
