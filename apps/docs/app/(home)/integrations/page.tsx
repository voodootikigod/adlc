import type { Metadata } from 'next';
import Link from 'next/link';
import { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import {
  UNIVERSAL_INSTALL,
  SKILLS_INSTALL,
  AGENT_PROMPT,
  AGENT_GUIDE_URL,
} from '@/lib/install-commands.mjs';
import { MarketingSection } from '@/components/marketing/section';
import { InstallCommand } from '@/components/marketing/install-command';
import { STATUS_LABEL } from '@/components/marketing/integration-card';

export const metadata: Metadata = {
  title: 'Integrations: Native to Your Agent',
  description:
    'Install the ADLC natively in Claude Code, Codex, Cursor, OpenCode, Pi, or Google Antigravity.',
};

export default function IntegrationsPage() {
  return (
    <main>
      <MarketingSection n="1" headingLevel={1} kicker="Integrations" title="Install it now">
        <p className="mb-8 max-w-[72ch] leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
          One command installs the gate toolkit and the native ADLC integration for
          each agent harness it finds on your machine. Harnesses you don&apos;t have
          are left alone. Requires Node 18+.
        </p>
        <div className="flex flex-col gap-4 lg:max-w-[72ch]">
          <InstallCommand command={UNIVERSAL_INSTALL} label="macOS / Linux" />
        </div>
        <p className="mt-6 max-w-[72ch] text-sm leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
          Then <code style={{ color: 'var(--rec-link)' }}>cd</code> into a repo and run{' '}
          <code style={{ color: 'var(--rec-link)' }}>adlc init</code>. Two exceptions the
          installer will tell you about: <strong style={{ color: 'var(--rec-ink)' }}>Cursor</strong>{' '}
          installs plugins through its in-app marketplace, and{' '}
          <strong style={{ color: 'var(--rec-ink)' }}>OpenCode</strong> scaffolds the current
          directory, so it belongs inside your repo. Both are detected and reported
          as a manual step rather than guessed at.{' '}
          <strong style={{ color: 'var(--rec-ink)' }}>Windows isn&apos;t supported yet</strong>{' '}
          — a <code style={{ color: 'var(--rec-link)' }}>windows-latest</code>{' '}
          run of the core gate suites passes 6 of 28, so use WSL for now. Prefer to install by hand?
          Every harness&apos;s native path is below.
        </p>
      </MarketingSection>

      <MarketingSection n="2" kicker="Hands-free" title="Or let your agent introduce you">
        <p className="mb-8 max-w-[72ch] leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
          Already running a coding agent? Let it do the onboarding. Paste this prompt
          — it reads a guide written for agents, works out which harness it is, and
          walks you through the install without running anything until you say so.
        </p>
        <div className="lg:max-w-[72ch]">
          <InstallCommand command={AGENT_PROMPT} label="Paste into your agent" />
        </div>
        <p className="mt-6 text-sm" style={{ color: 'var(--rec-ink-2)' }}>
          Read the guide yourself:{' '}
          <a href={AGENT_GUIDE_URL} style={{ color: 'var(--rec-link)' }}>
            agent-guide.md ↗
          </a>
        </p>
      </MarketingSection>

      {/* A banded clause: the record sinks the paper to group the harness list,
          rather than inverting to the terminal ground, which is reserved for
          evidence. */}
      <div style={{ background: 'var(--rec-paper-sunk)' }}>
        <MarketingSection n="3" kicker="Native integrations" title="Pick your agent">
          {/* An applicability register, not a card grid: one row per harness,
              with the install channel in the column reserved for it. */}
          <div style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
            <div
              className="hidden grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_28px] md:grid"
              style={{ background: 'var(--rec-paper-sunk)', borderBottom: '1px solid var(--rec-rule-strong)' }}
            >
              <div className="rec-legend px-3 py-2.5">Harness</div>
              <div className="rec-legend px-3 py-2.5">What it gets</div>
              <div className="rec-legend px-3 py-2.5">Install channel</div>
              <div className="rec-legend px-3 py-2.5" />
            </div>
            {INTEGRATIONS.map((i) => (
              <Link
                key={i.slug}
                href={`/integrations/${i.slug}`}
                className="group grid grid-cols-[minmax(0,1fr)_28px] items-baseline gap-y-1 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_28px]"
                style={{ borderBottom: '1px solid var(--rec-rule)', background: 'var(--rec-paper-raised)' }}
              >
                <span className="px-3 py-3 text-[15px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
                  {i.name}
                </span>
                <span
                  className="col-span-2 px-3 pb-1 text-[13.5px] leading-[1.5] md:col-span-1 md:py-3 md:pb-3"
                  style={{ color: 'var(--rec-ink-2)' }}
                >
                  {i.tagline}
                </span>
                <span
                  className="rec-mono col-span-2 px-3 pb-3 text-[12px] md:col-span-1 md:py-3"
                  style={{ color: 'var(--rec-ink-3)' }}
                >
                  {STATUS_LABEL[i.status]}
                </span>
                <span
                  aria-hidden
                  className="px-3 py-3 text-right transition-colors group-hover:text-[var(--rec-link)]"
                  style={{ color: 'var(--rec-ink-3)' }}
                >
                  →
                </span>
              </Link>
            ))}
          </div>
        </MarketingSection>
      </div>

      <MarketingSection n="4" kicker="Any other agent" title="No native plugin? Install the skills.">
        <p className="mb-8 max-w-[72ch] leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
          The harness-neutral skill catalog reaches roughly seventy agents through{' '}
          <a href="https://skills.sh" style={{ color: 'var(--rec-link)' }}>
            skills.sh
          </a>
          .
        </p>
        <div className="lg:max-w-[72ch]">
          <InstallCommand command={SKILLS_INSTALL} />
        </div>
        <p className="mt-6 max-w-[72ch] text-sm leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
          This channel installs <strong style={{ color: 'var(--rec-ink)' }}>skills only</strong> — the
          phase router, the bootstrap guide, and the P5 prosecution workflow, each driven
          through the <code style={{ color: 'var(--rec-link)' }}>adlc</code> CLI. It installs no hooks,
          no MCP tools, no agents, and no in-session rail enforcement, so it is strictly
          weaker than any native integration above. Where a native plugin exists, prefer it.
        </p>
      </MarketingSection>
    </main>
  );
}
