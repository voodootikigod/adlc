import { Exhibit, ExhibitOutput } from './record';
import { MARKETING_GATES } from '@/lib/marketing-gates.mjs';

/**
 * A numbered exhibit for an interior route, drawn from the same gate data the
 * homepage exhibits use. The memorable moment of this design is that no claim
 * of capability stands without an attached exhibit — a device that was
 * homepage-only until these routes got one each.
 *
 * The disclosure line ships with the exhibit, not beside it in page copy, so a
 * route can never render the capture without the honesty about what the
 * verdict line is.
 */
export function RouteExhibit({ id, gateName }: { id: string; gateName: string }) {
  const gate = MARKETING_GATES.find((g) => g.name === gateName);
  if (!gate) return null;
  return (
    <div className="lg:max-w-[72ch]">
      <Exhibit
        id={id}
        attachedTo={gate.gate}
        // Short name in the bar; the full command with its flags is the
        // capture's own $ line, so truncating it here would clip nothing but
        // still read as clipped.
        command={`adlc ${gate.name}`}
        status={gate.state === 'pass' ? 'EXIT 0 — PASS' : 'EXIT 2 — REFUSED'}
        verdict={gate.state === 'pass' ? 'pass' : 'fail'}
      >
        <ExhibitOutput output={gate.output} />
      </Exhibit>
      <p className="mt-2 max-w-[72ch] text-[12px]" style={{ color: 'var(--rec-ink-3)' }}>
        The command and exit code are real; the verdict line is this record&apos;s one-line summary
        of the result, not a verbatim transcript.
      </p>
    </div>
  );
}
