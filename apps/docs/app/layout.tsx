import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Archivo, Azeret_Mono } from 'next/font/google';
import type { Metadata } from 'next';
import { SITE_URL } from '@/lib/routes.mjs';
import { Analytics } from '@vercel/analytics/next';

// Archivo is a grotesque out of documentary and industrial printing, and it
// carries a width axis — which is what lets the record's statement clause be set
// narrow at panel scale without a second display face. Azeret Mono sets every
// identifier, exit code, and field legend: mono here is measurement and code,
// not costume.
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-record',
  display: 'swap',
});

const azeretMono = Azeret_Mono({
  subsets: ['latin'],
  variable: '--font-record-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'ADLC: The Agentic Development Lifecycle',
    template: '%s · ADLC',
  },
  description:
    'A software lifecycle built around how AI models actually fail: machine-checkable gates, auditable evidence, and native support for your coding agent.',
  // Relative canonical resolves per-route against metadataBase, so every page
  // self-canonicalizes to the www host without per-page boilerplate.
  alternates: {
    canonical: './',
  },
  openGraph: {
    siteName: 'ADLC',
    type: 'website',
    // A plain static path, deliberately query-string-free: Vercel Skew
    // Protection appends "?dpl=<id>" to same-origin URLs in the rendered
    // HTML without checking for an existing "?", and Next.js's
    // opengraph-image.png file convention appends its own cache-busting
    // query — the two collided into an invalid double-"?" URL that broke
    // Twitter's card fetch.
    images: [
      {
        url: '/opengraph-image.png',
        width: 1200,
        height: 630,
        alt: 'A single blue light trace crossing a glowing gate arch on a dark field: the ADLC mark.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/opengraph-image.png'],
  },
};

const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: 'ADLC: The Agentic Development Lifecycle',
      alternateName: 'ADLC',
      url: `${SITE_URL}/`,
      description:
        'A software lifecycle built around how AI models actually fail: machine-checkable gates, auditable evidence, and native support for your coding agent.',
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'ADLC',
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/icon.svg`,
      sameAs: [
        'https://github.com/voodootikigod/adlc',
        'https://voodootikigod.com/series/adlc',
      ],
    },
  ],
};

export default function Layout({ children }: LayoutProps<'/'>) {
  // dark class on <html> enforces dark mode — theme switching is disabled
  return (
    <html
      lang="en"
      className={`dark ${archivo.variable} ${azeretMono.variable} ${archivo.className}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
        <RootProvider theme={{ enabled: false }}>
          {children}
        </RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
