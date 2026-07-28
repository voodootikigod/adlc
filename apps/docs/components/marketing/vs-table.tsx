import { VS_SDLC_ROWS } from '@/lib/vs-sdlc.mjs';

// Ledger comparison: the ADLC column is the one tinted surface, so the eye
// reads it as the elevated column. align-top keeps rows legible where cell
// lengths are uneven (the Review row runs long). The overflow-x-auto wrapper
// is load-bearing — the table scrolls in its own container, never the page.
export function VsTable() {
  return (
    <div className="overflow-x-auto" style={{ borderTop: '1px solid var(--rec-rule-strong)' }}>
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr style={{ background: 'var(--rec-paper-sunk)', borderBottom: '1px solid var(--rec-rule-strong)' }}>
            <th
              scope="col"
              className="rec-legend p-3 text-left align-bottom"
            >
              Dimension
            </th>
            <th
              scope="col"
              className="rec-legend p-3 text-left align-bottom"
            >
              SDLC (built for humans)
            </th>
            <th
              scope="col"
              className="p-4 text-left align-bottom rec-mono text-xs font-semibold uppercase tracking-wider"
              // Blue is links only; the raised surface and heavier weight carry
              // the column's emphasis without borrowing the link hue.
              style={{ color: 'var(--rec-ink)', background: 'var(--rec-paper-raised)' }}
            >
              ADLC (built for models)
            </th>
          </tr>
        </thead>
        <tbody>
          {VS_SDLC_ROWS.map((r) => (
            <tr key={r.dimension} className="border-t" style={{ borderColor: 'var(--rec-rule)' }}>
              <th
                scope="row"
                className="w-[9.5rem] p-4 text-left align-top font-semibold"
                style={{ color: 'var(--rec-ink)' }}
              >
                {r.dimension}
              </th>
              <td className="p-4 align-top leading-relaxed" style={{ color: 'var(--rec-ink-2)' }}>
                {r.sdlc}
              </td>
              <td
                className="p-4 align-top leading-relaxed"
                style={{ color: 'var(--rec-ink)', background: 'var(--rec-paper-raised)', fontWeight: 500 }}
              >
                {r.adlc}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
