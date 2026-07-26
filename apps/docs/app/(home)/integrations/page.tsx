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
      <MarketingSection headingLevel={1} kicker="Integrations" title="Install it now">
        <p className="mb-8 max-w-2xl leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          One command installs the gate toolkit and the native ADLC integration for
          each agent harness it finds on your machine. Harnesses you don&apos;t have
          are left alone. Requires Node 18+.
        </p>
        <div className="flex flex-col gap-4 lg:max-w-2xl">
          <InstallCommand command={UNIVERSAL_INSTALL} label="macOS / Linux" />
        </div>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          Then <code style={{ color: '#4fb4d8' }}>cd</code> into a repo and run{' '}
          <code style={{ color: '#4fb4d8' }}>adlc init</code>. Two exceptions the
          installer will tell you about: <strong style={{ color: '#cbcdd2' }}>Cursor</strong>{' '}
          installs plugins through its in-app marketplace, and{' '}
          <strong style={{ color: '#cbcdd2' }}>OpenCode</strong> scaffolds the current
          directory, so it belongs inside your repo. Both are detected and reported
          as a manual step rather than guessed at.{' '}
          <strong style={{ color: '#cbcdd2' }}>Windows isn&apos;t supported yet</strong>{' '}
          — a <code style={{ color: '#4fb4d8' }}>windows-latest</code> run of the core
          gate suites passes 6 of 28, so use WSL for now. Prefer to install by hand?
          Every harness&apos;s native path is below.
        </p>
      </MarketingSection>

      <MarketingSection kicker="Hands-free" title="Or let your agent introduce you">
        <p className="mb-8 max-w-2xl leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          Already running a coding agent? Let it do the onboarding. Paste this prompt
          — it reads a guide written for agents, works out which harness it is, and
          walks you through the install without running anything until you say so.
        </p>
        <div className="lg:max-w-3xl">
          <InstallCommand command={AGENT_PROMPT} label="Paste into your agent" />
        </div>
        <p className="mt-6 text-sm" style={{ color: 'var(--mk-muted)' }}>
          Read the guide yourself:{' '}
          <a href={AGENT_GUIDE_URL} style={{ color: '#4fb4d8' }}>
            agent-guide.md ↗
          </a>
        </p>
      </MarketingSection>

      <div style={{ background: '#18191d' }}>
        <MarketingSection kicker="Native integrations" title="Pick your agent">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {INTEGRATIONS.map((i) => (
              <Link
                key={i.slug}
                href={`/integrations/${i.slug}`}
                className="group flex flex-col rounded-lg border p-5 transition-colors hover:border-[#4fb4d8]"
                style={{ borderColor: '#3f4044', background: '#26272c' }}
              >
                <p className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
                  {i.name}
                </p>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
                  {i.tagline}
                </p>
                <p
                  className="mt-auto flex items-center justify-between pt-4 font-mono text-xs"
                  style={{ color: 'var(--mk-muted)' }}
                >
                  <span>{STATUS_LABEL[i.status]}</span>
                  <span aria-hidden className="transition-colors group-hover:text-[#4fb4d8]">
                    →
                  </span>
                </p>
              </Link>
            ))}
          </div>
        </MarketingSection>
      </div>

      <MarketingSection kicker="Any other agent" title="No native plugin? Install the skills.">
        <p className="mb-8 max-w-2xl leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          The harness-neutral skill catalog reaches roughly seventy agents through{' '}
          <a href="https://skills.sh" style={{ color: '#4fb4d8' }}>
            skills.sh
          </a>
          .
        </p>
        <div className="lg:max-w-2xl">
          <InstallCommand command={SKILLS_INSTALL} />
        </div>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          This channel installs <strong style={{ color: '#cbcdd2' }}>skills only</strong> — the
          phase router, the bootstrap guide, and the P5 prosecution workflow, each driven
          through the <code style={{ color: '#4fb4d8' }}>adlc</code> CLI. It installs no hooks,
          no MCP tools, no agents, and no in-session rail enforcement, so it is strictly
          weaker than any native integration above. Where a native plugin exists, prefer it.
        </p>
      </MarketingSection>
    </main>
  );
}
