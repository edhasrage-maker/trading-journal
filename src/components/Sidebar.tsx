'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { todayPT } from '@/lib/pt-time'
import {
  TrendingUp,
  LayoutDashboard,
  ClipboardList,
  Activity,
  BarChart2,
  CalendarDays,
  Settings,
  Tag,
  Archive,
  Database,
  CandlestickChart,
  Brain,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const settingsItems = [
  { href: '/settings/coaching', label: 'Coaching', icon: Brain },
  { href: '/settings/tags', label: 'Tags', icon: Tag },
  { href: '/settings/stats', label: 'Perf Stats', icon: Settings },
  { href: '/settings/condition-lookup', label: 'Condition Lookup', icon: Database },
  { href: '/settings/bars', label: 'Bar Data', icon: CandlestickChart },
  { href: '/settings/sc-logs', label: 'SC Archives', icon: Archive },
]

export default function Sidebar() {
  const pathname = usePathname()
  // `today` is the PT session date (todayPT), not machine-local — a mis-set OS
  // timezone on either synced machine would otherwise point these links at the
  // wrong calendar day. Tick every minute so links roll over if the tab stays
  // open across midnight PT.
  const [today, setToday] = useState<string>(() => todayPT())
  useEffect(() => {
    const id = setInterval(() => {
      const next = todayPT()
      setToday(prev => (prev === next ? prev : next))
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  // Monday of the current week → /weekly/<thatMonday>. Derived from the PT
  // `today` string at noon UTC so the weekday is TZ-safe (noon dodges DST edges).
  const currentWeekMonday = (() => {
    const noon = new Date(`${today}T12:00:00Z`)
    const day = noon.getUTCDay()  // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(noon.getTime() + diff * 24 * 3600 * 1000)
    return monday.toISOString().slice(0, 10)
  })()

  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: `/prep/${today}`, label: 'Daily Prep', icon: ClipboardList },
    { href: `/intraday/${today}`, label: 'Intraday', icon: Activity },
    { href: `/eod/${today}`, label: 'EOD Recap', icon: BarChart2 },
    { href: `/weekly/${currentWeekMonday}`, label: 'Weekly Recap', icon: CalendarDays },
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

      {/* Settings */}
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
    </aside>
  )
}
