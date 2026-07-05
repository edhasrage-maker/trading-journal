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
  SlidersHorizontal,
  Gauge,
  LogOut,
  Menu,
  X,
  ChevronsLeft,
  ChevronsRight,
  Compass,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'
import { useSidebarCollapsed } from '@/lib/sidebar-collapsed'

// Settings nav. Coaching + Tags are for EVERY user. The rest are ADMIN-only:
// Condition Lookup is power-user config; Bar Data / SC Archives ALSO depend on
// local files (`.scid`, the SC data dir), so they're additionally local-only.
// Filtered per-user in the component (needs the runtime isAdmin), not here.
// `cloudOnly` items need the hosted service role (multi-tenant admin tools), so
// they're hidden in the local single-tenant owner build.
const settingsItems = [
  { href: '/settings/coaching', label: 'Player Profile', icon: Brain, localOnly: false, cloudOnly: false, adminOnly: false },
  { href: '/settings/account', label: 'Account Settings', icon: SlidersHorizontal, localOnly: false, cloudOnly: false, adminOnly: false },
  { href: '/settings/metrics', label: 'Metrics', icon: Gauge, localOnly: false, cloudOnly: false, adminOnly: false },
  { href: '/settings/tags', label: 'Tags', icon: Tag, localOnly: false, cloudOnly: false, adminOnly: false },
  { href: '/settings/condition-lookup', label: 'Condition Lookup', icon: Database, localOnly: false, cloudOnly: false, adminOnly: true },
  { href: '/settings/model-tiers', label: 'Model Tiers', icon: Sparkles, localOnly: false, cloudOnly: true, adminOnly: true },
  { href: '/settings/bars', label: 'Bar Data', icon: CandlestickChart, localOnly: true, cloudOnly: false, adminOnly: true },
  { href: '/settings/sc-logs', label: 'SC Archives', icon: Archive, localOnly: true, cloudOnly: false, adminOnly: true },
]

// data-tour anchor for the first-login SiteTour. Only the 4 workflow tabs get
// one; matched by href prefix so the dated Prep/EOD links resolve too. Applied
// to BOTH the desktop sidebar link and the mobile tab link — the tour's
// viewport-aware resolver targets whichever is visible.
function navTourAnchor(href: string): string | undefined {
  if (href.startsWith('/prep')) return 'nav-prep'
  if (href.startsWith('/eod')) return 'nav-eod'
  if (href === '/dashboard') return 'nav-dashboard'
  if (href === '/analytics') return 'nav-analytics'
  return undefined
}

export default function Sidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  // Per-user visible settings: everyone gets Coaching + Tags; the admin also
  // gets Condition Lookup, plus Bar Data / SC Archives in the local build (they
  // need `.scid` files).
  const visibleSettings = settingsItems.filter(
    item => (!item.localOnly || LOCAL_FEATURES_ENABLED)
      && (!item.cloudOnly || !LOCAL_FEATURES_ENABLED)
      && (!item.adminOnly || isAdmin),
  )
  const { mode, setMode } = useUiMode()
  // Desktop rail collapse — icon-only when collapsed; main content expands to
  // fill the reclaimed space (AppMain tracks the same state).
  const [collapsed, setCollapsed] = useSidebarCollapsed()

  // Mobile "More" sheet state (the bottom-tab-bar overflow menu). Desktop (md+)
  // shows the full sidebar and ignores this. Close on any route change so
  // tapping a link in the sheet dismisses it.
  const [moreOpen, setMoreOpen] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the More sheet on any route change (covers link taps + back/forward nav)
  useEffect(() => { setMoreOpen(false) }, [pathname])

  const signOut = async () => {
    await createClient().auth.signOut()
    router.push('/')
    router.refresh()
  }
  // Replay the first-login guided tour on demand (SiteTour listens for this).
  // Cloud-only, matching where the tour runs.
  const startTour = () => {
    setMoreOpen(false)
    window.dispatchEvent(new Event('tapescore:start-tour'))
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

  // The date the review tabs default to when NOT on a dated route: today once
  // today's prep is started, else the most-recently-traded day (/api/nav-anchor).
  // Refetched on navigation so it flips to today right after prep is saved.
  const [anchor, setAnchor] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/nav-anchor')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.anchor) setAnchor(d.anchor as string) })
      .catch(() => { /* fall back to today */ })
    return () => { cancelled = true }
  }, [pathname])

  // The "Welcome" entry is first-run orientation for new testers. Hide it once
  // the user has set up their profile (onboarding_json.status === 'completed'),
  // and always on the local owner build (there's no tester onboarding there — a
  // permanent Welcome link is just clutter for an established user). Starts
  // hidden until we know the status, so an established user never sees it flash
  // in and then out on load.
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null)
  useEffect(() => {
    if (LOCAL_FEATURES_ENABLED) return // owner build has no onboarding flow
    let cancelled = false
    fetch('/api/onboarding')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setOnboardingCompleted(d?.onboarding?.status === 'completed') })
      .catch(() => { /* unknown → Welcome stays hidden */ })
    return () => { cancelled = true }
  }, [])
  const showWelcome = !LOCAL_FEATURES_ENABLED && onboardingCompleted === false
  const welcomeItem = { href: '/welcome', label: 'Welcome', icon: Sparkles }

  // On a dated route (/prep|/intraday|/eod/<date>) the tabs stick to THAT date.
  // Otherwise Daily Prep points at today (where you start today's prep), while the
  // review tabs (Intraday/EOD/Weekly) follow the anchor — today once prep is
  // started, else your last traded day — so they don't land on an empty today.
  const urlDate = (() => {
    const m = /^\/(?:prep|intraday|eod)\/(\d{4}-\d{2}-\d{2})/.exec(pathname)
    return m ? m[1] : null
  })()
  const prepDate = urlDate ?? today
  const reviewDate = urlDate ?? anchor ?? today

  // Monday of the review week → /weekly/<thatMonday>. Noon UTC so the weekday is
  // TZ-safe (dodges DST edges).
  const weekMonday = (() => {
    const noon = new Date(`${reviewDate}T12:00:00Z`)
    const day = noon.getUTCDay()  // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(noon.getTime() + diff * 24 * 3600 * 1000)
    return monday.toISOString().slice(0, 10)
  })()

  const navItems = [
    ...(showWelcome ? [welcomeItem] : []),
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: `/prep/${prepDate}`, label: 'Daily Prep', icon: ClipboardList },
    { href: `/intraday/${reviewDate}`, label: 'Intraday', icon: Activity },
    { href: `/eod/${reviewDate}`, label: 'EOD Recap', icon: BarChart2 },
    { href: `/weekly/${weekMonday}`, label: 'Weekly Recap', icon: CalendarDays },
    { href: '/calendar', label: 'Calendar', icon: CalendarDays },
    { href: '/analytics', label: 'Analytics', icon: TrendingUp },
    { href: '/import', label: 'Import', icon: Upload },
  ]

  // Mobile: four primary tabs in the bottom bar; everything else lives in the
  // "More" sheet. (Desktop uses the full navItems list above, unchanged.)
  const mobileTabs = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, match: '/dashboard' },
    { href: `/prep/${prepDate}`, label: 'Prep', icon: ClipboardList, match: '/prep' },
    { href: `/eod/${reviewDate}`, label: 'EOD', icon: BarChart2, match: '/eod' },
    { href: '/analytics', label: 'Analytics', icon: TrendingUp, match: '/analytics' },
  ]
  const moreNav = [
    ...(showWelcome ? [welcomeItem] : []),
    { href: `/intraday/${reviewDate}`, label: 'Intraday', icon: Activity },
    { href: `/weekly/${weekMonday}`, label: 'Weekly Recap', icon: CalendarDays },
    { href: '/calendar', label: 'Calendar', icon: CalendarDays },
    { href: '/import', label: 'Import', icon: Upload },
  ]

  return (
    <>
      {/* Mobile top bar — logo only; navigation is the bottom tab bar. md:hidden. */}
      <div className="md:hidden fixed top-0 inset-x-0 h-14 z-30 flex items-center gap-2.5 px-4 bg-gray-900 border-b border-gray-800">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG */}
        <img src="/brand/tapescore-favicon.svg" alt="TapeScore" className="w-8 h-8" />
        <span className="text-lg tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
          <span className="font-medium">Tape</span><span className="font-extrabold">Score</span>
        </span>
      </div>

      {/* Desktop sidebar (md+ only). Mobile navigates via the bottom tab bar below.
          Collapses to an icon rail (w-16); AppMain's left margin tracks the same
          state so content expands into the reclaimed space. */}
      <aside className={cn(
        'hidden md:flex fixed left-0 top-0 h-dvh bg-gray-900 border-r border-gray-800 flex-col overflow-y-auto overflow-x-hidden z-50 transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60',
      )}>
      {/* Logo + collapse toggle */}
      <div className={cn('flex items-center border-b border-gray-800', collapsed ? 'flex-col gap-2 px-2 py-4' : 'gap-3 px-5 py-6')}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG, no image optimization needed */}
        <img src="/brand/tapescore-favicon.svg" alt="TapeScore" className={cn('flex-shrink-0', collapsed ? 'w-8 h-8' : 'w-10 h-10')} />
        {!collapsed && (
          <div className="flex flex-col gap-1 leading-none">
            <span className="text-xl tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
              <span className="font-medium">Tape</span><span className="font-extrabold">Score</span>
            </span>
            <span className="font-mono text-[9px] uppercase text-gray-500 whitespace-nowrap" style={{ letterSpacing: '0.1em' }}>
              Game film for traders
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
          className={cn('text-gray-500 hover:text-white transition-colors', collapsed ? '' : 'ml-auto')}
        >
          {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href.split('/').slice(0, 2).join('/'))
          return (
            <Link
              key={href}
              href={href}
              data-tour={navTourAnchor(href)}
              title={collapsed ? label : undefined}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                collapsed && 'justify-center',
                active
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && label}
            </Link>
          )
        })}
      </nav>

      {/* Settings — hidden entirely when no settings items are visible. */}
      {visibleSettings.length > 0 && (
      <div className="px-3 py-4 border-t border-gray-800 space-y-0.5">
        {!collapsed && <p className="px-3 text-xs text-gray-600 uppercase tracking-wider mb-2">Settings</p>}
        {visibleSettings.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                collapsed && 'justify-center',
                active
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && label}
            </Link>
          )
        })}
      </div>
      )}

      {/* View mode — Beginner (plain-English, default) vs Pro (full metrics).
          Hidden on the collapsed rail (needs width); expand to change it. */}
      {!collapsed && (
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
      )}

      {/* Take the tour — cloud-only replay of the first-login walkthrough. */}
      {!LOCAL_FEATURES_ENABLED && (
        <div className="px-3 pt-4">
          <button
            type="button"
            onClick={startTour}
            title={collapsed ? 'Take the tour' : undefined}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors',
              collapsed && 'justify-center',
            )}
          >
            <Compass className="w-4 h-4 flex-shrink-0" />
            {!collapsed && 'Take the tour'}
          </button>
        </div>
      )}

      {/* Sign out */}
      <div className="px-3 py-4">
        <button
          type="button"
          onClick={signOut}
          title={collapsed ? 'Sign out' : undefined}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors',
            collapsed && 'justify-center',
          )}
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!collapsed && 'Sign out'}
        </button>
      </div>
      </aside>

      {/* Mobile bottom tab bar (md:hidden) — four primary tabs + More. The
          floating coach FAB used to sit in the bottom-right corner over the
          More tab, so we reserved that corner (pr-20). It's since been lifted
          above this bar via #coach-fab-root CSS (globals.css), so the reserve
          is gone and the tabs span the full width. */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 flex bg-gray-900 border-t border-gray-800"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {mobileTabs.map(({ href, label, icon: Icon, match }) => {
          const active = pathname.startsWith(match)
          return (
            <Link
              key={label}
              href={href}
              data-tour={navTourAnchor(href)}
              className={cn(
                'flex-1 flex flex-col items-center justify-center gap-1 py-2 min-h-[56px] text-[10px] transition-colors',
                active ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300',
              )}
            >
              <Icon className="w-5 h-5" />
              {label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          className={cn(
            'flex-1 flex flex-col items-center justify-center gap-1 py-2 min-h-[56px] text-[10px] transition-colors',
            moreOpen ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300',
          )}
        >
          <Menu className="w-5 h-5" />
          More
        </button>
      </nav>

      {/* Mobile "More" sheet — secondary nav + Settings + View toggle + Sign out. */}
      {moreOpen && (
        <div className="md:hidden">
          <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setMoreOpen(false)} aria-hidden />
          <div
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-gray-900 border-t border-gray-800"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="sticky top-0 flex items-center justify-between px-5 py-4 bg-gray-900 border-b border-gray-800">
              <span className="text-sm font-semibold text-gray-200">More</span>
              <button type="button" onClick={() => setMoreOpen(false)} aria-label="Close" className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-3 py-3 space-y-0.5">
              {moreNav.map(({ href, label, icon: Icon }) => {
                const active = pathname === href || pathname.startsWith(href.split('/').slice(0, 2).join('/'))
                return (
                  <Link
                    key={label}
                    href={href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-colors',
                      active ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:text-white hover:bg-gray-800',
                    )}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    {label}
                  </Link>
                )
              })}
              {!LOCAL_FEATURES_ENABLED && (
                <button
                  type="button"
                  onClick={startTour}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
                >
                  <Compass className="w-4 h-4 flex-shrink-0" />
                  Take the tour
                </button>
              )}
            </div>
            {visibleSettings.length > 0 && (
              <div className="px-3 py-3 border-t border-gray-800 space-y-0.5">
                <p className="px-3 text-xs text-gray-600 uppercase tracking-wider mb-2">Settings</p>
                {visibleSettings.map(({ href, label, icon: Icon }) => {
                  const active = pathname.startsWith(href)
                  return (
                    <Link
                      key={href}
                      href={href}
                      className={cn(
                        'flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-colors',
                        active ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:text-white hover:bg-gray-800',
                      )}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {label}
                    </Link>
                  )
                })}
              </div>
            )}
            <div className="px-3 py-3 border-t border-gray-800">
              <p className="px-3 text-xs text-gray-600 uppercase tracking-wider mb-2">View</p>
              <div className="flex items-center gap-1 bg-gray-950/60 border border-gray-800 rounded-lg p-1">
                {(['beginner', 'pro'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={cn(
                      'flex-1 rounded-md py-2 text-xs whitespace-nowrap transition-colors',
                      mode === m ? 'bg-blue-600 font-semibold text-white' : 'text-gray-400 hover:text-white',
                    )}
                  >
                    {m === 'beginner' ? 'Highlights' : 'Detailed Tape'}
                  </button>
                ))}
              </div>
            </div>
            <div className="px-3 py-3 border-t border-gray-800">
              <button
                type="button"
                onClick={signOut}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
              >
                <LogOut className="w-4 h-4 flex-shrink-0" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
