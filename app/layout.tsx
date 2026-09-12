import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import '@openmaic/renderer/fonts.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { Toaster } from '@/components/ui/sonner';
import { ServerProvidersInit } from '@/components/server-providers-init';
import { StorageHealthNotice } from '@/components/storage-health-notice';
import { ProSwapWatcher } from '@/components/workbench/ProSwapWatcher';

// The UI font is loaded from @fontsource's stylesheet rather than next/font,
// because only the stylesheet carries the per-subset `unicode-range`
// declarations. Pointing next/font at `inter-latin-wght-normal.woff2` loaded
// exactly one subset, so every character outside Latin — Cyrillic for ru-RU,
// tone-marked letters for vi-VN — fell back to an arbitrary OS font and
// rendered in a different typeface mid-word.
//
// Declaring the other subset files as sibling faces of the same family does not
// fix it either: faces with identical descriptors and no `unicode-range` do not
// fall through per glyph, so the browser simply picks one.
//
// `--font-sans` moves to globals.css since the family no longer comes from
// next/font's generated class.
import '@fontsource-variable/inter';

// The persistence flag below reads DATABASE_URL at render time. Without this,
// every route without its own `dynamic` export (/ , /login, /_not-found …) is
// prerendered at build time — and production images build without .env*, so
// the injected script bakes `false` into the HTML forever. The browser then
// keeps the account scope on localStorage and settings never sync to the
// server, so the same account starts unconfigured on every other browser.
// force-dynamic on the root layout keeps the flag request-scoped for every
// route, mirroring the per-page exports on /workspace and /workbench/new.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'OpenMAIC',
  description:
    'The open-source AI interactive classroom. Upload a PDF to instantly generate an immersive, multi-agent learning experience.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        {/* Runs before any client bundle: the synchronous runtime/document
          storage seams read this flag at module load, so server-backed
          persistence follows the runtime DATABASE_URL with no build-time
          NEXT_PUBLIC_PERSISTENCE switch to keep in sync. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__OPENMAIC_PERSISTENCE_CONFIGURED__=${JSON.stringify(
              Boolean(process.env.DATABASE_URL),
            )};`,
          }}
        />
        <ThemeProvider>
          <I18nProvider>
            <ServerProvidersInit />
            <ProSwapWatcher />
            {children}
            <Toaster position="top-center" />
            {/* After the Toaster: this one raises a toast on mount when
                persistence is already broken, and a toast raised before its
                host exists has nowhere to go. */}
            <StorageHealthNotice />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
