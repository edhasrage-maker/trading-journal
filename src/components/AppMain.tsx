'use client'

import Link from 'next/link'

/**
 * The main content pane.
 *
 * Pt 14 retired the left rail for a fixed top masthead, so there is no left
 * margin to track any more — content runs full width and only needs to clear
 * the fixed chrome: the masthead (62px desktop / 56px mobile top bar) and, on
 * mobile, the bottom tab bar.
 */
export default function AppMain({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 min-w-0 p-6 pt-20 md:pt-[86px] pb-24 md:pb-10 overflow-y-auto">
      {children}
      {/* App-shell footer — gives signed-in users a path to the legal pages and
          support, which otherwise only exist on the logged-out landing. */}
      <footer className="mt-12 pt-6 border-t border-gray-900 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-gray-600">
        <span>TapeScore — beta</span>
        <span aria-hidden className="text-gray-700">·</span>
        <Link href="/privacy" className="text-gray-500 hover:text-gray-300">Privacy</Link>
        <Link href="/terms" className="text-gray-500 hover:text-gray-300">Terms</Link>
        <a href="mailto:support@tapescore.app" className="text-gray-500 hover:text-gray-300">Support</a>
      </footer>
    </main>
  )
}
