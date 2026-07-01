import { FAILURE_MODES } from '@/lib/failure-modes.mjs';
import { theoryLink } from '@/lib/theory-links.mjs';

export function FailureMode({ id }: { id: keyof typeof FAILURE_MODES }) {
  const fm = FAILURE_MODES[id];
  if (!fm) return null;
  return (
    <div
      className="my-4 rounded-md border-l-4 p-3"
      style={{ borderColor: '#ef7c2a', background: '#2f3137' }}
    >
      <strong>
        {id} — {fm.name}
      </strong>{' '}
      <a href={theoryLink(id)} className="text-sm">
        (theory ↗)
      </a>
    </div>
  );
}
