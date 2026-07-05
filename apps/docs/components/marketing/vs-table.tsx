import { VS_SDLC_ROWS } from '@/lib/vs-sdlc.mjs';

// Ledger comparison: the ADLC column is the one tinted surface, so the eye
// reads it as the elevated column. align-top keeps rows legible where cell
// lengths are uneven (the Review row runs long). The overflow-x-auto wrapper
// is load-bearing — the table scrolls in its own container, never the page.
export function VsTable() {
  return (
    <div className="overflow-x-auto rounded-lg border" style={{ borderColor: '#3f4044' }}>
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              className="p-4 text-left align-bottom font-mono text-xs font-medium uppercase tracking-wider"
              style={{ color: 'var(--mk-muted)' }}
            >
              Dimension
            </th>
            <th
              scope="col"
              className="p-4 text-left align-bottom font-mono text-xs font-medium uppercase tracking-wider"
              style={{ color: 'var(--mk-muted)' }}
            >
              SDLC (built for humans)
            </th>
            <th
              scope="col"
              className="p-4 text-left align-bottom font-mono text-xs font-medium uppercase tracking-wider"
              style={{ color: '#4fb4d8', background: '#26272c' }}
            >
              ADLC (built for models)
            </th>
          </tr>
        </thead>
        <tbody>
          {VS_SDLC_ROWS.map((r) => (
            <tr key={r.dimension} className="border-t" style={{ borderColor: '#3f4044' }}>
              <th
                scope="row"
                className="w-[9.5rem] p-4 text-left align-top font-semibold"
                style={{ color: '#cbcdd2' }}
              >
                {r.dimension}
              </th>
              <td className="p-4 align-top leading-relaxed" style={{ color: 'var(--mk-muted)' }}>
                {r.sdlc}
              </td>
              <td
                className="p-4 align-top leading-relaxed"
                style={{ color: '#cbcdd2', background: '#26272c' }}
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
