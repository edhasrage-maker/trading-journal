'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
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
  Sparkles,
  DollarSign,
  LogOut,
  Menu,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'

// Settings nav. Coaching + Tags are for EVERY user. The rest are ADMIN-only:
// Condition Lookup is power-user config; Bar Data / SC Archives ALSO depend on
// local files (`.scid`, the SC data dir), so they're additionally local-only.
// Filtered per-user in the component (needs the runtime isAdmin), not here.
const settingsItems = [
  { href: '/settings/coaching', label: 'Coaching', icon: Brain, localOnly: false, adminOnly: false },
  { href: '/settings/commissions', label: 'Commissions', icon: DollarSign, localOnly: false, adminOnly: false },
  { href: '/settings/tags', label: 'Tags', icon: Tag, localOnly: false, adminOnly: false },
  { href: '/settings/condition-lookup', label: 'Condition Lookup', icon: Database, localOnly: false, adminOnly: true },
  { href: '/settings/bars', label: 'Bar Data', icon: CandlestickChart, localOnly: true, adminOnly: true },
  { href: '/settings/sc-logs', label: 'SC Archives', icon: Archive, localOnly: true, adminOnly: true },
]

export default function Sidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  // Per-user visible settings: everyone gets Coaching + Tags; the admin also
  // gets Condition Lookup, plus Bar Data / SC Archives in the local build (they
  // need `.scid` files).
  const visibleSettings = settingsItems.filter(
    item => (!item.localOnly || LOCAL_FEATURES_ENABLED) && (!item.adminOnly || isAdmin),
  )
  const { mode, setMode } = useUiMode()

  // Mobile drawer state. On desktop (md+) the sidebar is always shown and this
  // is inert; below md it's an off-canvas drawer. Close it on any route change
  // so tapping a nav link slides it away and reveals the page.
  const [open, setOpen] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the drawer on any route change (covers link taps + back/forward nav)
  useEffect(() => { setOpen(false) }, [pathname])

  const signOut = async () => {
    await createClient().auth.signOut()
    router.push('/')
    router.refresh()
  }
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
    { href: '/welcome', label: 'Welcome', icon: Sparkles },
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
    <>
      {/* Mobile top bar — hamburger opens the drawer (md:hidden; desktop keeps the fixed sidebar) */}
      <div className="md:hidden fixed top-0 inset-x-0 h-14 z-30 flex items-center gap-3 px-4 bg-gray-900 border-b border-gray-800">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="text-gray-300 hover:text-white">
          <Menu className="w-6 h-6" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
        <img src="/brand/tapescore-favicon.svg" alt="TapeScore" className="w-7 h-7" />
        <span className="text-lg tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
          <span className="font-medium">Tape</span><span className="font-extrabold">Score</span>
        </span>
      </div>

      {/* Backdrop behind the open drawer (mobile only) */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setOpen(false)} aria-hidden />
      )}

      <aside
        className={cn(
          'fixed left-0 top-0 h-screen w-60 bg-gray-900 border-r border-gray-800 flex flex-col z-50 transition-transform duration-200 md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
      {/* Close (mobile only) */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close menu"
        className="md:hidden absolute top-4 right-3 text-gray-400 hover:text-white"
      >
        <X className="w-5 h-5" />
      </button>
      {/* Logo — TapeScore lockup: mark + wordmark, tagline aligned under the wordmark */}
      <div className="flex items-center gap-3 px-5 py-6 border-b border-gray-800">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG, no image optimization needed */}
        <img src="/brand/tapescore-favicon.svg" alt="TapeScore" className="w-10 h-10 flex-shrink-0" />
        <div className="flex flex-col gap-1 leading-none">
          <span className="text-xl tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
            <span className="font-medium">Tape</span><span className="font-extrabold">Score</span>
          </span>
          <span className="font-mono text-[9px] uppercase text-gray-500 whitespace-nowrap" style={{ letterSpacing: '0.1em' }}>
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
      {visibleSettings.length > 0 && (
      <div className="px-3 py-4 border-t border-gray-800 space-y-0.5">
        <p className="px-3 text-xs text-gray-600 uppercase tracking-wider mb-2">Settings</p>
        {visibleSettings.map(({ href, label, icon: Icon }) => {
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

      {/* View mode — Beginner (plain-English, default) vs Pro (full metrics) */}
      <div className="px-3 pt-4 border-t border-gray-800">
        <p className="px-3 text-xs text-gray-600 uppercase tracking-wider mb-2">View</p>
        <div className="flex items-center gap-1 bg-gray-950/60 border border-gray-800 rounded-lg p-1">
          {(['beginner', 'pro'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 rounded-md py-1.5 text-xs whitespace-nowrap transition-colors',
                mode === m ? 'bg-blue-600 font-semibold' : 'text-gray-400 hover:text-white',
              )}
              aria-pressed={mode === m}
            >
              {m === 'beginner' ? 'Highlights' : 'Detailed Tape'}
            </button>
          ))}
        </div>
      </div>

      {/* Sign out */}
      <div className="px-3 py-4">
        <button
          type="button"
          onClick={signOut}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
          Sign out
        </button>
      </div>
      </aside>
    </>
  )
}
