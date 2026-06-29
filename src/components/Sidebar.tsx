'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { format } from 'date-fns'
import {
  TrendingUp,
  LayoutDashboard,
  ClipboardList,
  Activity,
  BarChart2,
  CalendarDays,
  Upload,
  Archive,
  Database,
  CandlestickChart,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'

// Tags & Perf Stats are "Coming soon" stubs — omitted until built.
// Condition Lookup / Bar Data / SC Archives are owner/local-only tooling
// (Bar Data + SC Archives read local files; Condition Lookup writes the shared
// reference tables that are read-only for normal users) — shown only locally.
const settingsItems = [
  { href: '/settings/condition-lookup', label: 'Condition Lookup', icon: Database, show: LOCAL_FEATURES_ENABLED },
  { href: '/settings/bars', label: 'Bar Data', icon: CandlestickChart, show: LOCAL_FEATURES_ENABLED },
  { href: '/settings/sc-logs', label: 'SC Archives', icon: Archive, show: LOCAL_FEATURES_ENABLED },
].filter(i => i.show)

export default function Sidebar() {
  const pathname = usePathname()
  // Recompute `today` on each render so the date links stay current across midnight.
  // Also tick every minute so the links update if the tab stays open through midnight.
  const [today, setToday] = useState<string>(() => format(new Date(), 'yyyy-MM-dd'))
  useEffect(() => {
    const id = setInterval(() => {
      const next = format(new Date(), 'yyyy-MM-dd')
      setToday(prev => (prev === next ? prev : next))
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: `/prep/${today}`, label: 'Daily Prep', icon: ClipboardList },
    { href: `/intraday/${today}`, label: 'Intraday', icon: Activity },
    { href: `/eod/${today}`, label: 'EOD Recap', icon: BarChart2 },
    { href: '/import', label: 'Import', icon: Upload },
    { href: '/calendar', label: 'Calendar', icon: CalendarDays },
    { href: '/analytics', label: 'Analytics', icon: TrendingUp },
  ]

  return (
    <aside className="fixed left-0 top-0 h-screen w-60 bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-gray-800">
        <div className="bg-blue-600 p-1.5 rounded-lg">
          <TrendingUp className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-white text-sm">Trade Journal</span>
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href.split('/').slice(0, 2).join('/'))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                active
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Settings — hidden entirely when no items remain (e.g. cloud build) */}
      {settingsItems.length > 0 && (
      <div className="px-3 py-4 border-t border-gray-800 space-y-0.5">
        <p className="px-3 text-xs text-gray-600 uppercase tracking-wider mb-2">Settings</p>
        {settingsItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                active
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </Link>
          )
        })}
      </div>
      )}
    </aside>
  )
}
