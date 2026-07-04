'use client'

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
    </main>
  )
}
