import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { SITE_URL } from '@/lib/routes.mjs';

const inter = Inter({
  subsets: ['latin'],
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
  },
  twitter: {
    card: 'summary_large_image',
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
    <html lang="en" className={`dark ${inter.className}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
        <RootProvider theme={{ enabled: false }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
