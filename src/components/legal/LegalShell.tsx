import Link from 'next/link'

// Presentational wrapper for the public /privacy and /terms pages. Matches the
// dark landing theme. Server component — no client state. The `<article>` uses
// plain utility classes (not @tailwindcss/typography, which isn't installed) so
// headings/paragraphs/lists are styled explicitly below.
export default function LegalShell({
  title,
  lastUpdated,
  children,
}: {
  title: string
  lastUpdated: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-300">
      <header className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
          <img src="/brand/tapescore-logo.svg" alt="TapeScore" className="h-12 w-auto" />
        </Link>
        <Link href="/" className="text-sm font-medium text-blue-400 hover:text-blue-300">← Home</Link>
      </header>

      <main className="max-w-3xl mx-auto px-6 pb-24 pt-6">
        <h1 className="text-3xl font-bold text-white" style={{ fontFamily: 'var(--font-display)' }}>{title}</h1>
        <p className="mt-2 text-xs text-gray-500">Last updated: {lastUpdated}</p>

        <article
          className="mt-8 space-y-5 text-sm leading-relaxed text-gray-400
            [&_h2]:mt-10 [&_h2]:mb-1 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-white
            [&_h3]:mt-6 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-gray-200
            [&_a]:text-blue-400 [&_a]:hover:underline
            [&_strong]:text-gray-200
            [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5
            [&_li]:marker:text-gray-600"
        >
          {children}
        </article>
      </main>

      <footer className="border-t border-gray-900">
        <div className="max-w-3xl mx-auto px-6 py-8 flex items-center justify-between gap-4">
          <p className="text-xs text-gray-600">TapeScore — game film for traders</p>
          <div className="flex items-center gap-4 text-xs">
            <Link href="/privacy" className="text-gray-500 hover:text-gray-300">Privacy</Link>
            <Link href="/terms" className="text-gray-500 hover:text-gray-300">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
