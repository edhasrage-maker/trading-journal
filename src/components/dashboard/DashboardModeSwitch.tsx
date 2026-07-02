'use client'

import { useUiMode } from '@/lib/ui-mode'

/**
 * Picks the Beginner or Pro dashboard body based on the current UI mode.
 * `beginner` = the plain-English view; `children` = the full Pro view
 * (DashboardStats + Recent Days table), rendered exactly as before.
 */
export default function DashboardModeSwitch({
  beginner,
  children,
}: {
  beginner: React.ReactNode
  children: React.ReactNode
}) {
  const { mode } = useUiMode()
  return <>{mode === 'beginner' ? beginner : children}</>
}
