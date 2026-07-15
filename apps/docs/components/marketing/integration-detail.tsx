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
      <pre aria-label={bundle.ariaLabel} className="whitespace-pre-wrap" style={{ color: '#cbcdd2' }}>
        <span style={{ color: '#4fb4d8' }}>{bundle.root}</span>
        {bundle.entries.map((entry) => (
          <span key={entry.path}>
            {'\n'}
            {entry.path.padEnd(pathWidth + 2)}
            <span style={{ color: 'var(--mk-muted)' }}>{bundleNote(integration, entry)}</span>
          </span>
        ))}
      </pre>
    </TerminalCard>
  );
}

function SurfaceCounts({ integration }: { integration: Integration }) {
  return (
    <dl className="grid grid-cols-2 border-y sm:grid-cols-4" style={{ borderColor: '#3f4044' }}>
      {integration.surfaces.map((surface, index) => (
        <div
          key={surface.key}
          className={`py-4 ${index % 2 === 0 ? 'pr-4' : 'border-l pl-4'} ${index > 1 ? 'border-t sm:border-t-0' : ''} sm:border-l sm:px-4 sm:first:border-l-0 sm:first:pl-0`}
          style={{ borderColor: '#3f4044' }}
        >
          <dt className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--mk-muted)' }}>
            {surface.label}
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: '#cbcdd2' }}>
            {surface.count}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function NativeSurfaces({ integration }: { integration: Integration }) {
  return (
    <div className="border-y" style={{ borderColor: '#3f4044' }}>
      {integration.surfaces.map((surface, index) => (
        <article
          key={surface.key}
          className="grid gap-4 border-b py-7 last:border-b-0 md:grid-cols-[4rem_1fr_1.2fr] md:gap-8"
          style={{ borderColor: '#3f4044' }}
        >
          <p className="font-mono text-xs" style={{ color: '#4fb4d8' }}>
            0{index + 1} / {surface.label}
          </p>
          <div>
            <h3 className="text-lg font-semibold" style={{ color: '#cbcdd2' }}>
              {surface.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
              {surface.detail}
            </p>
          </div>
          <ul className="flex flex-wrap content-start gap-2" aria-label={`${surface.label} included`}>
            {surface.items.map((item) => (
              <li
                key={item}
                className="rounded border px-2.5 py-1 font-mono text-xs"
                style={{ borderColor: '#3f4044', color: '#cbcdd2', background: '#26272c' }}
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
    <div className="overflow-x-auto border-y" style={{ borderColor: '#3f4044' }}>
      <table className="w-full min-w-[42rem] border-collapse text-left">
        <thead>
          <tr className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--mk-muted)' }}>
            <th className="py-3 pr-6 font-medium">Phase</th>
            <th className="px-6 py-3 font-medium">{integration.phaseSection.entryHeader}</th>
            <th className="py-3 pl-6 font-medium">Evidence produced</th>
          </tr>
        </thead>
        <tbody>
          {integration.phaseRoutes.map((route) => (
            <tr key={route.phase} className="border-t" style={{ borderColor: '#3f4044' }}>
              <th className="py-4 pr-6 font-mono text-sm font-medium" style={{ color: '#4fb4d8' }}>
                {route.phase}
              </th>
              <td className="px-6 py-4 font-mono text-sm" style={{ color: '#cbcdd2' }}>
                {route.entry}
              </td>
              <td className="py-4 pl-6 text-sm" style={{ color: 'var(--mk-muted)' }}>
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
    <div className="grid border-y md:grid-cols-2" style={{ borderColor: '#3f4044' }}>
      <div className="py-6 pr-0 md:pr-8">
        <p className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: '#e5cd52' }}>
          {session.kicker}
        </p>
        <h3 className="mt-2 text-lg font-semibold" style={{ color: '#cbcdd2' }}>
          {session.title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          {session.body}
        </p>
      </div>
      <div className="border-t py-6 md:border-l md:border-t-0 md:pl-8" style={{ borderColor: '#3f4044' }}>
        <p className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: '#78bd65' }}>
          {ci.kicker}
        </p>
        <h3 className="mt-2 text-lg font-semibold" style={{ color: '#cbcdd2' }}>
          {ci.title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
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
            <span key={`${index}-${line}`} style={{ color: isComment ? 'var(--mk-muted)' : '#cbcdd2' }}>
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
          <a key={resource.href} href={resource.href} style={{ color: '#4fb4d8' }}>
            {resource.label}
          </a>
        ) : (
          <Link key={resource.href} href={resource.href} style={{ color: '#4fb4d8' }}>
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
    <p className="mb-8 max-w-2xl leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
      {parts.map((part, index) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={`${part}-${index}`} style={{ color: '#4fb4d8' }}>
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
            <p className="max-w-2xl text-lg leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
              {integration.tagline} {integration.hero.identity}
            </p>
            <div className="my-8 flex flex-wrap gap-2">
              {integration.hero.badges.map((badge) => (
                <span
                  key={badge.label}
                  className="rounded border px-2.5 py-1 font-mono text-xs"
                  style={
                    badge.accent
                      ? { borderColor: '#4fb4d8', color: '#4fb4d8' }
                      : { borderColor: '#3f4044', color: 'var(--mk-muted)' }
                  }
                >
                  {badge.label}
                </span>
              ))}
            </div>
            <SurfaceCounts integration={integration} />
          </div>
          <NativeBundle integration={integration} />
        </div>
      </MarketingSection>

      <div style={{ background: '#18191d' }}>
        <MarketingSection kicker={integration.surfacesSection.kicker} title={integration.surfacesSection.title}>
          <NativeSurfaces integration={integration} />
        </MarketingSection>
      </div>

      <MarketingSection kicker={integration.phaseSection.kicker} title={integration.phaseSection.title}>
        <IntroWithCode text={integration.phaseSection.intro} />
        <PhaseRouting integration={integration} />
      </MarketingSection>

      <div style={{ background: '#18191d' }}>
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
