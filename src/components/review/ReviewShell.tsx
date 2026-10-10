'use client'

import { usePathname } from 'next/navigation'

/**
 * Review's content column. The time-scoped views read best at a fixed measure;
 * Deep Dive is a full-screen chart workspace, so it gets the whole width.
 */
export default function ReviewShell({ children }: { children: React.ReactNode }) {
  const full = usePathname().startsWith('/review/deep-dive')
  return <div className={full ? 'w-full' : 'mx-auto w-full max-w-[1080px]'}>{children}</div>
}
