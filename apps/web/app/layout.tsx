import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { ThemeProvider, ThemeToggle } from '@/components/theme';
import './globals.css';
import '@fontsource-variable/figtree';

export const metadata: Metadata = {
  title: { default: 'DirectiveBench', template: '%s · DirectiveBench' },
  description: 'Local-first workbench for AI agent skills, instructions and rules.',
};

// Every page reads the local SQLite database at request time.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="font-sans">
      <body className="min-h-screen">
        <ThemeProvider>
          <div className="flex min-h-screen">
            <aside className="sticky top-0 hidden h-screen w-sidebar shrink-0 flex-col gap-6 border-r bg-sidebar p-3 md:flex">
              <div className="flex items-center justify-between px-2 pt-1">
                <Link href="/" className="text-sm font-semibold tracking-tight">
                  DirectiveBench
                </Link>
                <ThemeToggle />
              </div>
              <Nav />
              <p className="mt-auto px-2 text-caption text-muted-foreground">
                Local-first · data stays on this machine
              </p>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex items-center justify-between border-b px-4 py-2 md:hidden">
                <Link href="/" className="text-sm font-semibold">
                  DirectiveBench
                </Link>
                <ThemeToggle />
              </header>
              <details className="border-b px-4 py-2 md:hidden">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Navigation
                </summary>
                <div className="pt-2">
                  <Nav />
                </div>
              </details>
              <main className="mx-auto w-full max-w-content flex-1 px-page-inline py-page-block">
                {children}
              </main>
            </div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
