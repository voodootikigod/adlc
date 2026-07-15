import Link from 'next/link';
import type { Metadata } from 'next';
import { FAILURE_MODES } from '@/lib/failure-modes.mjs';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { SERIES_BASE, theoryLink } from '@/lib/theory-links.mjs';
import { ALL_PACKAGES } from '@/lib/toolkit-packages.mjs';
import { SITE_URL } from '@/lib/routes.mjs';
import { MARKETING_GATES } from '@/lib/marketing-gates.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { TerminalCard } from '@/components/marketing/terminal-card';
import { Backdrop } from '@/components/marketing/backdrop';
import { Barbell } from '@/components/marketing/barbell';
import { GateSequence } from '@/components/marketing/gate-sequence';
import { LifecyclePipeline } from '@/components/marketing/lifecycle-pipeline';

export const metadata: Metadata = {
  description:
    'The SDLC defends against human failure modes. Your agents fail differently. ADLC gives every phase an explicit exit contract: deterministic gates produce evidence, and human gates record attestation.',
};

const APP_STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'ADLC Toolkit',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Node.js >= 18',
  url: `${SITE_URL}/toolkit`,
  license: 'https://github.com/voodootikigod/adlc/blob/main/LICENSE',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  description:
    'Zero-dependency CLIs that each enforce one machine-checkable gate of the Agentic Development Lifecycle.',
  sameAs: ['https://github.com/voodootikigod/adlc'],
};

// Gate results stay glyph + word (spec §4); color only reinforces the verdict.
function TerminalOutput({ output }: { output: string }) {
  return (
    <pre className="whitespace-pre-wrap">
      {output.split('\n').map((line, i) => {
        const color = line.startsWith('✓')
          ? 'var(--adlc-pass)'
          : line.startsWith('✗')
            ? 'var(--mk-fail-text)'
            : '#cbcdd2';
        return (
          <span key={i} style={{ color }}>
            {i > 0 ? '\n' : ''}
            {line}
          </span>
        );
      })}
    </pre>
  );
}

export default function HomePage() {
  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(APP_STRUCTURED_DATA) }}
      />
      {/* 1 — Hero */}
      <Backdrop slug="hero-backdrop">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 pb-24 pt-20 md:pt-32">
          <h1
            className="mk-fade-up max-w-3xl text-balance text-4xl font-bold leading-[1.08] tracking-tight md:text-6xl"
            style={{ color: '#cbcdd2' }}
          >
            Your agents don&apos;t fail like humans.{' '}
            <span style={{ color: '#4fb4d8' }}>Stop managing them like humans.</span>
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
            The Agentic Development Lifecycle rebuilds software delivery around the ways
            models actually fail. Every phase has an explicit exit contract: deterministic
            gates leave machine-checkable evidence, and human gates record attestation.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link
              href="/integrations"
              className="rounded-md px-5 py-2.5 font-medium"
              style={{ background: '#4fb4d8', color: '#1c1d21' }}
            >
              Install for your agent
            </Link>
            <Link
              href="/vs-sdlc"
              className="rounded-md border px-5 py-2.5 font-medium"
              style={{ borderColor: '#3f4044', color: '#cbcdd2' }}
            >
              Why ADLC
            </Link>
          </div>
          <div
            className="mt-4 rounded-lg border p-6"
            style={{ borderColor: '#3f4044', background: 'rgba(38,39,44,0.85)' }}
          >
            <GateSequence />
          </div>
        </div>
      </Backdrop>

      {/* 2 — The problem */}
      <MarketingSection kicker="The problem" title="Eight ways agents fail. None of them human.">
        <div className="overflow-hidden rounded-lg border" style={{ borderColor: '#3f4044' }}>
          <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-4" style={{ background: '#3f4044' }}>
            {Object.entries(FAILURE_MODES).map(([id, fm]) => (
              <div key={id} className="p-5" style={{ background: '#26272c' }}>
                <p className="font-mono text-xs" style={{ color: '#ef7c2a' }}>{id}</p>
                <p className="mt-1 font-semibold" style={{ color: '#cbcdd2' }}>{fm.name}</p>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>{fm.tagline}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-6 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <Link href="/failure-modes" style={{ color: '#4fb4d8' }}>See which gate kills each one →</Link>
        </p>
      </MarketingSection>

      {/* 3 — The lifecycle */}
      <MarketingSection kicker="The lifecycle" title="Eight phases. A gate between every one.">
        <LifecyclePipeline />
        <p className="mt-6 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <Link href="/lifecycle" style={{ color: '#4fb4d8' }}>Explore the phases and gates →</Link>
        </p>
      </MarketingSection>

      {/* 4 — Gates, not vibes */}
      <MarketingSection kicker="Gates, not vibes" title="Every claim gets checked by a machine">
        <div className="grid gap-4 md:grid-cols-2">
          {MARKETING_GATES.map((t) => (
            <TerminalCard key={t.name} title={`${t.name}: ${t.gate}`}>
              <TerminalOutput output={t.output} />
            </TerminalCard>
          ))}
        </div>
        <p className="mt-6 text-sm" style={{ color: 'var(--mk-muted)' }}>
          <Link href="/toolkit" style={{ color: '#4fb4d8' }}>{`All ${ALL_PACKAGES.length} packages, grouped by phase →`}</Link>
        </p>
      </MarketingSection>

      {/* 5 — Native to your agent */}
      <MarketingSection kicker="Integrations" title="Native to the agent you already use">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((i) => (
            <Link
              key={i.slug}
              href={`/integrations/${i.slug}`}
              className="rounded-lg border p-4 transition-colors hover:border-[#4fb4d8]"
              style={{ borderColor: '#3f4044', background: '#26272c' }}
            >
              <p className="font-semibold" style={{ color: '#cbcdd2' }}>{i.name}</p>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>{i.tagline}</p>
            </Link>
          ))}
        </div>
      </MarketingSection>

      {/* 6 — Economics: the barbell */}
      <MarketingSection kicker="Economics" title="Spend heavy at the ends, light in the middle.">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <Barbell />
          <div className="flex flex-col gap-6">
            <blockquote
              className="border-l-2 pl-5 text-xl font-medium leading-snug"
              style={{ borderColor: '#ef7c2a', color: '#cbcdd2' }}
            >
              The unit of account is cost per merged, verified change. Not
              tokens per developer per month.
            </blockquote>
            <p className="leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
              This is the SDLC inverted, because misbuilding is expensive and
              building is cheap. Review stops being the bottleneck, and it goes
              deeper than a human team could sustain anyway. Every merge carries
              an evidence manifest, so auditors get an answer without an
              engineer translating. Senior time goes to the two human gates
              instead of rubber-stamping diffs. And each run costs a little less
              than the last, as findings distill into lints and skills nobody
              has to learn twice.
            </p>
            <p className="text-sm">
              <a href={theoryLink('distill')} style={{ color: '#4fb4d8' }}>
                The lifecycle gets cheaper ↗
              </a>
              <span className="px-2" style={{ color: 'var(--mk-muted)' }}>·</span>
              <Link href="/vs-sdlc" style={{ color: '#4fb4d8' }}>
                ADLC vs the enterprise SDLC →
              </Link>
            </p>
          </div>
        </div>
      </MarketingSection>

      {/* 7 — Enterprise band */}
      <div className="border-y" style={{ borderColor: '#3f4044', background: '#26272c' }}>
        <MarketingSection kicker="Enterprise" title="Rolling out agentic development across an org?">
          <p className="max-w-2xl text-lg leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
            Unreviewable agent output is an audit problem, not just an engineering problem.
            ADLC produces a gate-by-gate evidence trail your auditors can actually read.
          </p>
          <Link
            href="/enterprise"
            className="mt-6 inline-block rounded-md border px-5 py-2.5 font-medium"
            style={{ borderColor: '#4fb4d8', color: '#4fb4d8' }}
          >
            Do it right →
          </Link>
        </MarketingSection>
      </div>

      {/* 8 — Theory footer band */}
      <div className="border-t" style={{ borderColor: '#3f4044' }}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-12">
          <p className="text-sm" style={{ color: 'var(--mk-muted)' }}>
            ADLC began as an essay series.{' '}
            <a href={`${SERIES_BASE}/series/adlc`} style={{ color: '#4fb4d8' }}>
              Read the original theory at voodootikigod.com ↗
            </a>
          </p>
          <a href="/privacy" className="text-sm underline" style={{ color: 'var(--mk-muted)' }}>
            Privacy
          </a>
        </div>
      </div>
    </main>
  );
}
