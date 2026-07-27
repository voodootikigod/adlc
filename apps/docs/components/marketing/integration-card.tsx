import type { INTEGRATIONS } from '@/lib/integration-facts.mjs';
import { TerminalCard } from './terminal-card';

export const STATUS_LABEL: Record<string, string> = {
  installer: 'One-line install',
  source: 'Install from source',
  local: 'Local plugin install',
  marketplace: 'Marketplace plugin',
};

interface IntegrationCardProps {
  integration: (typeof INTEGRATIONS)[number];
}

// Install text is contractual — render verbatim; comment lines are only dimmed, never rewritten.
//
// These colours are the TERMINAL side of the system, not the record side: this
// pre renders inside a capture on #1c1d21. Paper inks here are invisible.
function InstallLines({ lines }: { lines: readonly string[] }) {
  return (
    <pre className="whitespace-pre-wrap">
      {lines.map((line, i) => (
        <span key={i} style={{ color: line.startsWith('#') ? '#686b78' : '#cbcdd2' }}>
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
          className="rec-legend border px-2 py-1"
          style={{ borderColor: 'var(--rec-rule-strong)', background: 'var(--rec-paper-sunk)' }}
        >
          {STATUS_LABEL[integration.status]}
        </span>
      </div>
      <TerminalCard title={`install: ${integration.name}`}>
        <InstallLines lines={integration.install} />
      </TerminalCard>
      {note ? (
        <p className="text-sm leading-relaxed" style={{ color: 'var(--rec-gate-ink)' }}>
          <span aria-hidden>◌ </span>
          {note}
        </p>
      ) : null}
    </div>
  );
}
