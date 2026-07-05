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
    default: 'ADLC — The Agentic Development Lifecycle',
    template: '%s · ADLC',
  },
  description:
    'The software lifecycle designed for how frontier models actually fail — machine-checkable gates, auditable evidence, native to your coding agent.',
  openGraph: {
    siteName: 'ADLC',
    type: 'website',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  // dark class on <html> enforces dark mode — theme switching is disabled
  return (
    <html lang="en" className={`dark ${inter.className}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider theme={{ enabled: false }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
