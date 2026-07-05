import type { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { TerminalCard } from './terminal-card';

export const STATUS_LABEL: Record<string, string> = {
  installer: 'One-line install',
  source: 'Install from source',
  local: 'Local plugin install',
};

interface IntegrationCardProps {
  integration: (typeof INTEGRATIONS)[number];
}

// Install text is contractual — render verbatim; comment lines are only dimmed, never rewritten.
function InstallLines({ lines }: { lines: readonly string[] }) {
  return (
    <pre className="whitespace-pre-wrap">
      {lines.map((line, i) => (
        <span key={i} style={{ color: line.startsWith('#') ? 'var(--mk-muted)' : '#cbcdd2' }}>
          {i > 0 ? '\n' : ''}
          {line}
        </span>
      ))}
    </pre>
  );
}

export function IntegrationCard({ integration }: IntegrationCardProps) {
  const note = 'note' in integration ? integration.note : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span
          className="rounded border px-2 py-0.5 font-mono text-xs"
          style={{ borderColor: '#3f4044', color: 'var(--mk-muted)' }}
        >
          {STATUS_LABEL[integration.status]}
        </span>
      </div>
      <TerminalCard title={`install: ${integration.name}`}>
        <InstallLines lines={integration.install} />
      </TerminalCard>
      {note ? (
        <p className="text-sm leading-relaxed" style={{ color: '#e5cd52' }}>
          <span aria-hidden>◌ </span>
          {note}
        </p>
      ) : null}
    </div>
  );
}
