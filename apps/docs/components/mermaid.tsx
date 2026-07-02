'use client';
import { useEffect, useId, useState } from 'react';

let initialized = false;

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[:]/g, '');
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let active = true;
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        if (!initialized) {
          mermaid.initialize({ startOnLoad: false, theme: 'dark', darkMode: true });
          initialized = true;
        }
        const { svg: rendered } = await mermaid.render(`m${id}`, chart);
        if (active) setSvg(rendered);
      })
      .catch((err) => console.error('mermaid render failed', err));
    return () => {
      active = false;
    };
  }, [chart, id]);

  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}
