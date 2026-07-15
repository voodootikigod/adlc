import { buildPhaseMermaid } from '@/lib/phase-graph.mjs';
import { theoryLink } from '@/lib/theory-links.mjs';
import { Mermaid } from './mermaid';

export function PhaseDiagram({ phase }: { phase: string }) {
  return (
    <figure className="my-4">
      <Mermaid chart={buildPhaseMermaid(phase)} />
      <figcaption className="text-sm" style={{ color: 'var(--color-fd-muted-foreground)' }}>
        The ADLC lifecycle, with {phase} highlighted.{' '}
        <a href={theoryLink(phase)}>Read the theory for {phase}</a>
      </figcaption>
    </figure>
  );
}
