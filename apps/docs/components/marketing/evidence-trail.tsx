const STEPS = [
  { label: 'Ticket', detail: 'Executable spec, dials set at triage' },
  { label: 'Gates', detail: 'spec-lint · premortem · rails-guard · hollow-test · prosecute' },
  { label: 'gate-manifest', detail: 'Every verdict recorded as a machine-readable artifact' },
  { label: 'Merge', detail: 'Approved on evidence, not vibes' },
] as const;

// Chain of custody: how a change becomes auditable.
//
// Custody is recorded, not drawn. The numbered hand-offs carry the sequence the
// way a custody form does, so the rail-and-arrow SVG that used to sit between
// the cells is gone — it was decorating an order the numbering already states,
// and on paper it read as a hairline nobody could see.
export function EvidenceTrail() {
  return (
    <ol
      className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-4"
      style={{ background: 'var(--rec-rule)', border: '1px solid var(--rec-rule)' }}
      aria-label="Evidence trail from ticket through gates and gate-manifest to merge"
    >
      {STEPS.map((s, i) => (
        <li key={s.label} className="flex flex-col p-4" style={{ background: 'var(--rec-paper-raised)' }}>
          <p className="rec-mono text-[10px] tracking-[0.2em]" style={{ color: 'var(--rec-ink-3)' }}>
            {String(i + 1).padStart(2, '0')}
            {i < STEPS.length - 1 ? <span aria-hidden> → HAND-OFF</span> : <span aria-hidden> · CLOSED</span>}
          </p>
          <p className="mt-1.5 rec-mono text-[14px] font-semibold" style={{ color: 'var(--rec-ink)' }}>
            {s.label}
          </p>
          <p className="mt-1.5 text-[12.5px] leading-[1.5]" style={{ color: 'var(--rec-ink-2)' }}>
            {s.detail}
          </p>
        </li>
      ))}
    </ol>
  );
}
