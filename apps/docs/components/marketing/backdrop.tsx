import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';

interface BackdropProps {
  slug: string;
  children: ReactNode;
}

// Server component: uses the generated asset when present, else a token-gradient
// fallback — the site must build and ship with zero generated images (spec §4).
export function Backdrop({ slug, children }: BackdropProps) {
  const file = path.join(process.cwd(), 'public', 'generated', `${slug}.png`);
  const hasImage = existsSync(file);
  const style = hasImage
    ? {
        backgroundImage: `linear-gradient(rgba(28,29,33,0.72), rgba(28,29,33,0.94)), url(/generated/${slug}.png)`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    : {
        background:
          'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(79,180,216,0.18), transparent), #1c1d21',
      };
  return (
    <div className="relative isolate" style={style}>
      {children}
    </div>
  );
}
