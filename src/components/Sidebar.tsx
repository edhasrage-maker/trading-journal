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
  Settings,
  Tag,
  Archive,
  Database,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const settingsItems = [
  { href: '/settings/tags', label: 'Tags', icon: Tag },
  { href: '/settings/stats', label: 'Perf Stats', icon: Settings },
  { href: '/settings/condition-lookup', label: 'Condition Lookup', icon: Database },
  { href: '/settings/sc-logs', label: 'SC Archives', icon: Archive },
]

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
