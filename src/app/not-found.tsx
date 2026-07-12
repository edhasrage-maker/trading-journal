import Link from 'next/link'

/**
 * Branded 404 — replaces the raw white Next.js default so a mistyped or stale
 * URL keeps the user inside TapeScore's shell with a way back. (Bare section
 * routes like /prep and /eod redirect to today instead of landing here.)
 */
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="font-mono text-xs tracking-[0.3em] text-gray-600 uppercase">404 · off the tape</div>
        <h1 className="text-2xl font-bold text-white mt-3">This page doesn&apos;t exist.</h1>
        <p className="text-sm text-gray-400 mt-2">
          The link may be stale, or the date in the URL may be off. Your journal is safe — it&apos;s just not here.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="px-4 py-2 rounded-lg bg-amber-500 text-gray-950 text-sm font-semibold hover:bg-amber-400 transition-colors"
          >
            Back to dashboard
          </Link>
          <Link
            href="/prep"
            className="px-4 py-2 rounded-lg border border-gray-700 text-gray-300 text-sm hover:border-gray-500 transition-colors"
          >
            Today&apos;s prep
          </Link>
        </div>
      </div>
    </div>
  )
}
