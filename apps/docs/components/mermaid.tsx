'use client';
import { useEffect, useId, useState } from 'react';

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[:]/g, '');
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let active = true;
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', darkMode: true });
      const { svg: rendered } = await mermaid.render(`m${id}`, chart);
      if (active) setSvg(rendered);
    });
    return () => {
      active = false;
    };
  }, [chart, id]);

  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}
