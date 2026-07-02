import Link from 'next/link';
import { theoryLink } from '@/lib/theory-links.mjs';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-bold" style={{ color: '#4fb4d8' }}>
        The Agentic Development Lifecycle
      </h1>
      <p className="mt-4 text-lg">
        The SDLC is 60 years of defenses against <em>human</em> failure modes.
        Models fail differently — premature satisfaction, sycophancy, context rot,
        confident hallucination, reward hacking. ADLC redesigns every phase, gate,
        and loop around <em>those</em> flaws.
      </p>
      <div className="mt-8 flex gap-4">
        <Link href="/docs" className="rounded-md px-4 py-2 font-medium"
          style={{ background: '#4fb4d8', color: '#1c1d21' }}>
          Read the docs
        </Link>
        <a href={theoryLink('toolkit')} className="rounded-md px-4 py-2 font-medium"
          style={{ border: '1px solid #3f4044' }}>
          The theory ↗
        </a>
      </div>
      <pre className="mt-8 rounded-md p-4" style={{ background: '#2f3137' }}>
{`npm install -g @adlc/cli
npx plugins add voodootikigod/adlc
adlc spec-lint <spec.md>`}
      </pre>
    </main>
  );
}
