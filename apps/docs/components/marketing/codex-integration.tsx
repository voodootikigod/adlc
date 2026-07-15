import Link from 'next/link';
import { CODEX_INTEGRATION } from '@/lib/integration-facts.mjs';
import { IntegrationCard } from './integration-card';
import { MarketingSection } from './section';
import { TerminalCard } from './terminal-card';

const SOURCE_URL = 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-codex';
const OFFICIAL_CODEX_PLUGIN_DOCS = 'https://developers.openai.com/codex/build-plugins';

function NativeBundle() {
  return (
    <TerminalCard title="adlc-codex / native bundle">
      <pre aria-label="Native Codex plugin payload" className="whitespace-pre-wrap" style={{ color: '#cbcdd2' }}>
        <span style={{ color: '#4fb4d8' }}>adlc-codex/</span>
        {'\n'}├─ .codex-plugin/plugin.json <span style={{ color: 'var(--mk-muted)' }}>manifest</span>
        {'\n'}├─ skills/                   <span style={{ color: 'var(--mk-muted)' }}>6 phase-aware workflows</span>
        {'\n'}├─ hooks/hooks.json          <span style={{ color: 'var(--mk-muted)' }}>8 lifecycle events</span>
        {'\n'}├─ .mcp.json                 <span style={{ color: 'var(--mk-muted)' }}>2 allowlisted tools</span>
        {'\n'}└─ agents/                   <span style={{ color: 'var(--mk-muted)' }}>3 project role templates</span>
      </pre>
    </TerminalCard>
  );
}

function SurfaceCounts() {
  return (
    <dl className="grid grid-cols-2 border-y sm:grid-cols-4" style={{ borderColor: '#3f4044' }}>
      {CODEX_INTEGRATION.surfaces.map((surface, index) => (
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

function NativeSurfaces() {
  return (
    <div className="border-y" style={{ borderColor: '#3f4044' }}>
      {CODEX_INTEGRATION.surfaces.map((surface, index) => (
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

function PhaseRouting() {
  return (
    <div className="overflow-x-auto border-y" style={{ borderColor: '#3f4044' }}>
      <table className="w-full min-w-[42rem] border-collapse text-left">
        <thead>
          <tr className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--mk-muted)' }}>
            <th className="py-3 pr-6 font-medium">Phase</th>
            <th className="px-6 py-3 font-medium">Codex entry</th>
            <th className="py-3 pl-6 font-medium">Evidence produced</th>
          </tr>
        </thead>
        <tbody>
          {CODEX_INTEGRATION.phaseRoutes.map((route) => (
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

function EnforcementBoundary() {
  return (
    <div className="grid border-y md:grid-cols-2" style={{ borderColor: '#3f4044' }}>
      <div className="py-6 pr-0 md:pr-8">
        <p className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: '#e5cd52' }}>
          In the session
        </p>
        <h3 className="mt-2 text-lg font-semibold" style={{ color: '#cbcdd2' }}>
          Fast feedback before a frozen rail changes
        </h3>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          The PreToolUse hook automatically activates for the selected incomplete ticket. Conflicting or stale ticket state fails closed once enforcement is active.
        </p>
      </div>
      <div className="border-t py-6 md:border-l md:border-t-0 md:pl-8" style={{ borderColor: '#3f4044' }}>
        <p className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: '#78bd65' }}>
          In CI
        </p>
        <h3 className="mt-2 text-lg font-semibold" style={{ color: '#cbcdd2' }}>
          Authoritative proof over the committed diff
        </h3>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          Hooks are immediate guardrails, not a complete security boundary. Keep the repository rails-guard job required so the trusted base ref decides what may merge.
        </p>
      </div>
    </div>
  );
}

function OperatingCommands() {
  return (
    <TerminalCard title="operate: Codex plugin">
      <pre className="whitespace-pre-wrap" style={{ color: '#cbcdd2' }}>
        <span style={{ color: 'var(--mk-muted)' }}># Refresh the Git marketplace snapshot</span>
        {'\n'}codex plugin marketplace upgrade adlc
        {'\n'}codex plugin list --json --available
        {'\n\n'}<span style={{ color: 'var(--mk-muted)' }}># Replace the older compatibility install</span>
        {'\n'}codex plugin remove adlc@plugins-cli
        {'\n'}codex plugin add adlc-codex@adlc
      </pre>
    </TerminalCard>
  );
}

export function CodexIntegrationPage() {
  return (
    <main>
      <MarketingSection headingLevel={1} kicker="Codex integration" title="The lifecycle, packaged for Codex">
        <div className="grid items-start gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div>
            <p className="max-w-2xl text-lg leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
              {CODEX_INTEGRATION.tagline} This is a Codex plugin, not a translated Claude compatibility layer.
            </p>
            <div className="my-8 flex flex-wrap gap-2">
              <span className="rounded border px-2.5 py-1 font-mono text-xs" style={{ borderColor: '#4fb4d8', color: '#4fb4d8' }}>
                Native plugin
              </span>
              <span className="rounded border px-2.5 py-1 font-mono text-xs" style={{ borderColor: '#3f4044', color: 'var(--mk-muted)' }}>
                Available from source
              </span>
            </div>
            <SurfaceCounts />
          </div>
          <NativeBundle />
        </div>
      </MarketingSection>

      <div style={{ background: '#18191d' }}>
        <MarketingSection kicker="Native surfaces" title="Codex sees the lifecycle where work happens">
          <NativeSurfaces />
        </MarketingSection>
      </div>

      <MarketingSection kicker="Phase routing" title="One entry point for each kind of evidence">
        <p className="mb-8 max-w-2xl leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
          Start with <code style={{ color: '#4fb4d8' }}>$adlc</code>. The router hands the task to a focused skill, while the resulting evidence remains portable under <code style={{ color: '#4fb4d8' }}>.adlc/</code>.
        </p>
        <PhaseRouting />
      </MarketingSection>

      <div style={{ background: '#18191d' }}>
        <MarketingSection kicker="Frozen rails" title="Immediate feedback, backed by merge-time proof">
          <EnforcementBoundary />
        </MarketingSection>
      </div>

      <MarketingSection kicker="Install" title="Install the current native plugin from source">
        <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
          <IntegrationCard integration={CODEX_INTEGRATION} />
          <OperatingCommands />
        </div>
        <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm" aria-label="Codex integration resources">
          <Link href="/docs/integrations/codex" style={{ color: '#4fb4d8' }}>
            Read the complete integration guide →
          </Link>
          <a href={SOURCE_URL} style={{ color: '#4fb4d8' }}>
            Inspect the plugin source →
          </a>
          <a href={OFFICIAL_CODEX_PLUGIN_DOCS} style={{ color: '#4fb4d8' }}>
            Codex plugin documentation →
          </a>
        </nav>
      </MarketingSection>
    </main>
  );
}
