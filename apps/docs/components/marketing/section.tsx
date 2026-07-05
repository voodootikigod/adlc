import type { ReactNode } from 'react';

interface MarketingSectionProps {
  id?: string;
  kicker?: string;
  title: string;
  // Interior pages pass 1 for their lead section so every page has exactly
  // one h1; visual treatment is identical either way.
  headingLevel?: 1 | 2;
  children: ReactNode;
}

export function MarketingSection({ id, kicker, title, headingLevel = 2, children }: MarketingSectionProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <section id={id} className="mx-auto w-full max-w-5xl scroll-mt-24 px-6 py-20 md:py-28">
      {kicker ? (
        <p
          className="mb-3 font-mono text-xs font-medium uppercase tracking-[0.2em]"
          style={{ color: '#4fb4d8' }}
        >
          {kicker}
        </p>
      ) : null}
      <Heading
        className="max-w-3xl text-balance text-3xl font-bold leading-tight tracking-tight md:text-4xl"
        style={{ color: '#cbcdd2' }}
      >
        {title}
      </Heading>
      <div className="mt-10">{children}</div>
    </section>
  );
}
