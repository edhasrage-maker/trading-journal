'use client'

import { usePathname } from 'next/navigation'

/**
 * Review's content column. The time-scoped views read best at a fixed measure;
 * Replay Review is a full-screen chart workspace, so it gets the whole width.
 */
export default function ReviewShell({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const full = path.startsWith('/review/replay') || path.startsWith('/review/deep-dive')
  return <div className={full ? 'w-full' : 'mx-auto w-full max-w-[1080px]'}>{children}</div>
}
