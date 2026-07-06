'use client'

import Link from 'next/link'
import { useSidebarCollapsed } from '@/lib/sidebar-collapsed'

/**
 * The main content pane. Its desktop left margin tracks the sidebar's collapsed
 * state (ml-16 collapsed / ml-60 expanded) so content expands to fill the space
 * the collapsed rail frees up. Mobile is unaffected (no left margin; bottom tab
 * bar + top bar clearance via pt/pb).
 */
export default function AppMain({ children }: { children: React.ReactNode }) {
  const [collapsed] = useSidebarCollapsed()
  return (
    <main
      className={`flex-1 p-6 pt-20 md:pt-6 pb-24 md:pb-6 overflow-y-auto transition-[margin] duration-200 ${
        collapsed ? 'md:ml-16' : 'md:ml-60'
      }`}
    >
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
