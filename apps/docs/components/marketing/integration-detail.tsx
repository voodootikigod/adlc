import Link from 'next/link';
import type { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { IntegrationCard } from './integration-card';
import { MarketingSection } from './section';
import { TerminalCard } from './terminal-card';

type Integration = (typeof INTEGRATIONS)[number];

function bundleNote(integration: Integration, entry: Integration['bundle']['entries'][number]): string {
  if (!entry.surfaceKey) return entry.note;
  const surface = integration.surfaces.find((s) => s.key === entry.surfaceKey);
  if (!surface) return entry.note;
  return `${surface.count} ${entry.note}`;
}

function NativeBundle({ integration }: { integration: Integration }) {
  const { bundle } = integration;
  const pathWidth = Math.max(...bundle.entries.map((entry) => entry.path.length));
  return (
    <TerminalCard title={bundle.title}>
      {/* Terminal side: paper inks are invisible on #1c1d21. */}
      <pre aria-label={bundle.ariaLabel} className="whitespace-pre-wrap" style={{ color: '#cbcdd2' }}>
        <span style={{ color: '#4fb4d8' }}>{bundle.root}</span>
        {bundle.entries.map((entry) => (
          <span key={entry.path}>
            {'\n'}
            {entry.path.padEnd(pathWidth + 2)}
            <span style={{ color: '#686b78' }}>{bundleNote(integration, entry)}</span>
          </span>
        ))}
      </pre>
    </TerminalCard>
  );
}

function SurfaceCounts({ integration }: { integration: Integration }) {
  return (
    // A hairline lattice, so a fifth surface fills its own cell instead of
    // hanging off a fixed four-column rule with a stray border beside it.
    // Per-cell rules rather than a gap-px lattice: the surface count is 5 on
    // some harnesses and 4 on others, and a lattice leaves the container colour
    // showing as an empty block wherever the last row is short.
    <dl className="grid grid-cols-2 sm:grid-cols-4" style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
      {integration.surfaces.map((surface) => (
        <div
          key={surface.key}
          className="px-3 py-3"
          style={{
            background: 'var(--rec-paper-raised)',
            borderRight: '1px solid var(--rec-rule)',
            borderBottom: '1px solid var(--rec-rule)',
          }}
        >
          <dt className="rec-legend">{surface.label}</dt>
          <dd className="mt-1 text-[22px] font-semibold tabular-nums" style={{ color: 'var(--rec-ink)' }}>
            {surface.count}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function NativeSurfaces({ integration }: { integration: Integration }) {
  return (
    <div className="border-y" style={{ borderColor: 'var(--rec-rule)' }}>
      {integration.surfaces.map((surface, index) => (
        <article
          key={surface.key}
          className="grid gap-4 border-b py-7 last:border-b-0 md:grid-cols-[4rem_1fr_1.2fr] md:gap-8"
          style={{ borderColor: 'var(--rec-rule)' }}
        >
          <p className="rec-mono text-xs" style={{ color: 'var(--rec-link)' }}>
            0{index + 1} / {surface.label}
          </p>
          <div>
            <h3 className="text-lg font-semibold" style={{ color: 'var(--rec-ink)' }}>
              {surface.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
              {surface.detail}
            </p>
          </div>
          <ul className="flex flex-wrap content-start gap-2" aria-label={`${surface.label} included`}>
            {surface.items.map((item) => (
              <li
                key={item}
                className="border px-2.5 py-1 rec-mono text-xs"
                style={{ borderColor: 'var(--rec-rule)', color: 'var(--rec-ink)', background: 'var(--rec-paper-raised)' }}
              >
                {item}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

function PhaseRouting({ integration }: { integration: Integration }) {
  return (
    <div className="overflow-x-auto border-y" style={{ borderColor: 'var(--rec-rule)' }}>
      <table className="w-full min-w-[42rem] border-collapse text-left">
        <thead>
          <tr className="rec-mono text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--rec-ink-2)' }}>
            <th className="py-3 pr-6 font-medium">Phase</th>
            <th className="px-6 py-3 font-medium">{integration.phaseSection.entryHeader}</th>
            <th className="py-3 pl-6 font-medium">Evidence produced</th>
          </tr>
        </thead>
        <tbody>
          {integration.phaseRoutes.map((route) => (
            <tr key={route.phase} className="border-t" style={{ borderColor: 'var(--rec-rule)' }}>
              <th className="py-4 pr-6 rec-mono text-sm font-medium" style={{ color: 'var(--rec-link)' }}>
                {route.phase}
              </th>
              <td className="px-6 py-4 rec-mono text-sm" style={{ color: 'var(--rec-ink)' }}>
                {route.entry}
              </td>
              <td className="py-4 pl-6 text-sm" style={{ color: 'var(--rec-ink-2)' }}>
                {route.evidence}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnforcementBoundary({ integration }: { integration: Integration }) {
  const { session, ci } = integration.enforcement;
  return (
    <div className="grid border-y md:grid-cols-2" style={{ borderColor: 'var(--rec-rule)' }}>
      <div className="py-6 pr-0 md:pr-8">
        <p className="rec-mono text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--rec-gate-ink)' }}>
          {session.kicker}
        </p>
        <h3 className="mt-2 text-lg font-semibold" style={{ color: 'var(--rec-ink)' }}>
          {session.title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
          {session.body}
        </p>
      </div>
      <div className="border-t py-6 md:border-l md:border-t-0 md:pl-8" style={{ borderColor: 'var(--rec-rule)' }}>
        <p className="rec-mono text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--rec-pass-ink)' }}>
          {ci.kicker}
        </p>
        <h3 className="mt-2 text-lg font-semibold" style={{ color: 'var(--rec-ink)' }}>
          {ci.title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
          {ci.body}
        </p>
      </div>
    </div>
  );
}

function OperatingCommands({ integration }: { integration: Integration }) {
  if (!integration.operate) return null;
  return (
    <TerminalCard title={integration.operate.title}>
      <pre className="whitespace-pre-wrap" style={{ color: '#cbcdd2' }}>
        {integration.operate.lines.map((line, index) => {
          const isComment = line.startsWith('#');
          const isBlank = line.length === 0;
          return (
            <span key={`${index}-${line}`} style={{ color: isComment ? '#686b78' : '#cbcdd2' }}>
              {index > 0 ? '\n' : ''}
              {isBlank ? '' : line}
            </span>
          );
        })}
      </pre>
    </TerminalCard>
  );
}

function ResourceNav({ integration }: { integration: Integration }) {
  return (
    <nav
      className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm"
      aria-label={`${integration.name} integration resources`}
    >
      {integration.resources.map((resource) =>
        resource.external ? (
          <a key={resource.href} href={resource.href} style={{ color: 'var(--rec-link)' }}>
            {resource.label}
          </a>
        ) : (
          <Link key={resource.href} href={resource.href} style={{ color: 'var(--rec-link)' }}>
            {resource.label}
          </Link>
        ),
      )}
    </nav>
  );
}

function IntroWithCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <p className="mb-8 max-w-[72ch] leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
      {parts.map((part, index) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={`${part}-${index}`} style={{ color: 'var(--rec-link)' }}>
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </p>
  );
}

/** Rich marketing page shared by every harness integration (Codex pattern). */
export function IntegrationDetailPage({ integration }: { integration: Integration }) {
  return (
    <main>
      <MarketingSection headingLevel={1} kicker={integration.hero.kicker} title={integration.hero.title}>
        <div className="grid items-start gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div>
            <p className="max-w-[72ch] text-lg leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
              {integration.tagline} {integration.hero.identity}
            </p>
            <div className="my-8 flex flex-wrap gap-2">
              {integration.hero.badges.map((badge) => (
                <span
                  key={badge.label}
                  className="border px-2.5 py-1 rec-mono text-xs"
                  style={
                    badge.accent
                      ? { borderColor: 'var(--rec-link)', color: 'var(--rec-link)' }
                      : { borderColor: 'var(--rec-rule)', color: 'var(--rec-ink-2)' }
                  }
                >
                  {badge.label}
                </span>
              ))}
            </div>
            <SurfaceCounts integration={integration} />
          </div>
          {/* Install leads the hero. The bundle tree is orientation, not action,
              so it moves down beside the surfaces it actually describes. */}
          <IntegrationCard integration={integration} />
        </div>
      </MarketingSection>

      <div style={{ background: 'var(--rec-paper-sunk)' }}>
        <MarketingSection kicker={integration.surfacesSection.kicker} title={integration.surfacesSection.title}>
          <div className="mb-10 lg:max-w-md">
            <NativeBundle integration={integration} />
          </div>
          <NativeSurfaces integration={integration} />
        </MarketingSection>
      </div>

      <MarketingSection kicker={integration.phaseSection.kicker} title={integration.phaseSection.title}>
        <IntroWithCode text={integration.phaseSection.intro} />
        <PhaseRouting integration={integration} />
      </MarketingSection>

      <div style={{ background: 'var(--rec-paper-sunk)' }}>
        <MarketingSection kicker={integration.railsSection.kicker} title={integration.railsSection.title}>
          <EnforcementBoundary integration={integration} />
        </MarketingSection>
      </div>

      <MarketingSection kicker={integration.installSection.kicker} title={integration.installSection.title}>
        <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
          <IntegrationCard integration={integration} />
          <OperatingCommands integration={integration} />
        </div>
        <ResourceNav integration={integration} />
      </MarketingSection>
    </main>
  );
}
