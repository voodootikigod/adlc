const STEPS = [
  { label: 'Ticket', detail: 'Executable spec, dials set at triage' },
  { label: 'Gates', detail: 'spec-lint · premortem · rails-guard · hollow-test · prosecute' },
  { label: 'gate-manifest', detail: 'Every verdict recorded as a machine-readable artifact' },
  { label: 'Merge', detail: 'Approved on evidence, not vibes' },
] as const;

// Chain of custody: how a change becomes auditable.
//
// Custody is recorded, not drawn — and it is a sequence, so the record writes
// it the way it writes every sequence: ruled rows with a numbered hand-off,
// not a grid of same-size cards. (The card lattice this replaced was the exact
// number-heading-text scaffold the rollout section's own comment rejects.)
export function EvidenceTrail() {
  return (
    <ol
      style={{ borderTop: '1px solid var(--rec-rule-strong)' }}
      aria-label="Evidence trail from ticket through gates and gate-manifest to merge"
    >
      {STEPS.map((s, i) => (
        <li
          key={s.label}
          className="grid grid-cols-1 gap-x-6 px-1 py-4 md:grid-cols-[52px_170px_minmax(0,1fr)]"
          style={{ borderBottom: '1px solid var(--rec-rule)', background: 'var(--rec-paper-raised)' }}
        >
          <span className="rec-mono px-2 pt-0.5 text-[11px] tracking-[0.1em]" style={{ color: 'var(--rec-ink-3)' }}>
            {String(i + 1).padStart(2, '0')}
          </span>
          <span className="rec-mono px-2 text-[14px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
            {s.label}
          </span>
          <span className="px-2 text-[14px] leading-[1.55]" style={{ color: 'var(--rec-ink-2)' }}>
            {s.detail}
            <span aria-hidden className="rec-mono ml-2 text-[11px]" style={{ color: 'var(--rec-ink-3)' }}>
              {i < STEPS.length - 1 ? '→ hand-off' : '· closed'}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
