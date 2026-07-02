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
  Tag,
  Archive,
  Database,
  CandlestickChart,
  Brain,
  Upload,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'

// Settings nav. Coaching + Tags are real features and always shown. The
// "Perf Stats" page is a non-functional stub — hidden everywhere. Condition
// Lookup / Bar Data / SC Archives depend on local files (`.scid`, the SC data
// dir) so they only appear in the local power-user build.
const settingsItems = [
  { href: '/settings/coaching', label: 'Coaching', icon: Brain, localOnly: false },
  { href: '/settings/tags', label: 'Tags', icon: Tag, localOnly: false },
  { href: '/settings/condition-lookup', label: 'Condition Lookup', icon: Database, localOnly: true },
  { href: '/settings/bars', label: 'Bar Data', icon: CandlestickChart, localOnly: true },
  { href: '/settings/sc-logs', label: 'SC Archives', icon: Archive, localOnly: true },
].filter(item => LOCAL_FEATURES_ENABLED || !item.localOnly)

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

  // The day the user is actually viewing. When the URL is a dated route
  // (/prep|/intraday|/eod/<date>), keep the day tabs pointed at THAT date so
  // switching tabs while reviewing a prior session doesn't yank them back to
  // today — the user picks the day, navigation preserves it. Falls back to
  // `today` on non-dated routes (dashboard, analytics, calendar, settings).
  const viewedDate = (() => {
    const m = /^\/(?:prep|intraday|eod)\/(\d{4}-\d{2}-\d{2})/.exec(pathname)
    return m ? m[1] : today
  })()

  // Monday of the viewed week → /weekly/<thatMonday>. Anchored to viewedDate so
  // the Weekly tab follows the session you're reviewing, not the current week.
  // Computed at noon UTC so the weekday is TZ-safe (noon dodges DST edges).
  const weekMonday = (() => {
    const noon = new Date(`${viewedDate}T12:00:00Z`)
    const day = noon.getUTCDay()  // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(noon.getTime() + diff * 24 * 3600 * 1000)
    return monday.toISOString().slice(0, 10)
  })()

  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: `/prep/${viewedDate}`, label: 'Daily Prep', icon: ClipboardList },
    { href: `/intraday/${viewedDate}`, label: 'Intraday', icon: Activity },
    { href: `/eod/${viewedDate}`, label: 'EOD Recap', icon: BarChart2 },
    { href: `/weekly/${weekMonday}`, label: 'Weekly Recap', icon: CalendarDays },
    { href: '/calendar', label: 'Calendar', icon: CalendarDays },
    { href: '/analytics', label: 'Analytics', icon: TrendingUp },
    { href: '/import', label: 'Import', icon: Upload },
  ]

  return (
    <aside className="fixed left-0 top-0 h-screen w-60 bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Logo — TapeScore lockup: mark + wordmark, tagline aligned under the wordmark */}
      <div className="flex items-center gap-2 px-5 py-5 border-b border-gray-800">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG, no image optimization needed */}
        <img src="/brand/tapescore-favicon.svg" alt="TapeScore" className="w-7 h-7 flex-shrink-0" />
        <div className="flex flex-col gap-0.5 leading-none">
          <span className="text-[15px] tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
            <span className="font-medium">Tape</span><span className="font-extrabold">Score</span>
          </span>
          <span className="font-mono text-[8px] uppercase text-gray-500 whitespace-nowrap" style={{ letterSpacing: '0.14em' }}>
            Game film for traders
          </span>
        </div>
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

      {/* Settings — hidden entirely when no settings items are visible. */}
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
