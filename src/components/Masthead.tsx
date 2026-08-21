'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { todayPT } from '@/lib/pt-time'
import { cn } from '@/lib/utils'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'
import ThemeToggle from '@/components/ThemeToggle'
import BrandLockup from '@/components/BrandLockup'

/**
 * The app masthead — top text nav, no left rail.
 *
 * Replaces the lucide icon sidebar (Pt 14). Two founder rulings drive this:
 * the thin left rail of stock lucide icons was THE tell that made TapeScore
 * read like every other AI-built trading journal, and the locked design
 * language is "premium from type, proportion and spacing" — so navigation is
 * words, and the only active-state signal is a 2px accent underline.
 *
 * Nav is `Prep · Trade · EOD · Review · Calendar · Patterns`. The locked set is
 * five items — EOD folds into Review's Today view (docs/REVIEW_EOD_MERGE_SPEC.md)
 * — but /review doesn't exist yet, so EOD stays reachable until that route
 * lands and this becomes a one-item deletion. "Dashboard" is already retired as
 * a label: it's the generic AI-dashboard word, and that screen IS Review·Month.
 */

// data-tour anchors for the first-login SiteTour (src/lib/site-tour.ts targets
// nav-prep / nav-eod / nav-analytics). Matched by href prefix so the dated Prep
// link resolves. Applied to both the masthead link and the mobile tab — the
// tour's viewport-aware resolver targets whichever is visible. 'nav-eod' points
// at Review (the session debrief); 'nav-dashboard' at the home overview.
function navTourAnchor(href: string): string | undefined {
  if (href === '/dashboard') return 'nav-dashboard'
  if (href.startsWith('/prep')) return 'nav-prep'
  if (href.startsWith('/review')) return 'nav-eod'
  if (href === '/analytics') return 'nav-analytics'
  return undefined
}

// Settings destinations. Coaching + Account + Metrics + Tags are for every
// user; the rest are admin-only, and Bar Data / SC Archives additionally need
// local `.scid` files. `cloudOnly` items need the hosted service role.
const settingsItems = [
  { href: '/settings/coaching', label: 'Player Profile', localOnly: false, cloudOnly: false, adminOnly: false },
  // Cloud-only: the local owner build grades on the built-in v1.3 rubric and
  // never reads scoring_profile_json, so showing an editor there would lie.
  { href: '/settings/rules', label: 'Trading Rules', localOnly: false, cloudOnly: true, adminOnly: false },
  { href: '/settings/account', label: 'Account Settings', localOnly: false, cloudOnly: false, adminOnly: false },
  { href: '/settings/metrics', label: 'Metrics', localOnly: false, cloudOnly: false, adminOnly: false },
  { href: '/settings/tags', label: 'Tags', localOnly: false, cloudOnly: false, adminOnly: false },
  { href: '/settings/condition-lookup', label: 'Condition Lookup', localOnly: false, cloudOnly: false, adminOnly: true },
  { href: '/settings/model-tiers', label: 'Model Tiers', localOnly: false, cloudOnly: true, adminOnly: true },
  { href: '/settings/bars', label: 'Bar Data', localOnly: true, cloudOnly: false, adminOnly: true },
  { href: '/settings/sc-logs', label: 'SC Archives', localOnly: true, cloudOnly: false, adminOnly: true },
]


/** Highlights / Detailed Tape — the view toggle, text-only with an underline. */
// Two invented labels sitting in the masthead with nothing to say what they do:
// a newcomer can't tell whether they're views, sections or account tiers. Each
// carries a one-line explanation on hover.
const VIEW_TOGGLE_TITLES = {
  beginner: 'Highlights — the short version: your score, one focus, and recent sessions.',
  pro: 'Detailed Tape — everything: full stats, charts and every breakdown.',
} as const

function ViewToggle({ compact = false }: { compact?: boolean }) {
  const { mode, setMode } = useUiMode()
  return (
    <div className={cn('flex items-center', compact ? 'gap-2.5' : 'gap-3')}>
      {(['beginner', 'pro'] as const).map(m => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          title={VIEW_TOGGLE_TITLES[m]}
          aria-pressed={mode === m}
          className={cn(
            // The active underline is 2px of border over 2px of padding, which
            // made these buttons 4px taller than every plain-text sibling in the
            // cluster. items-center then centred that taller box and left
            // Import, Dark and Account sitting low against them. -mb-1 hangs the
            // underline below the line box so all four share a text baseline.
            'whitespace-nowrap transition-colors border-b-2 pb-0.5 -mb-1',
            compact ? 'text-[11.5px]' : 'text-[12.5px]',
            mode === m
              ? 'text-gray-100 font-semibold border-blue-500'
              : 'text-gray-500 hover:text-gray-300 border-transparent',
          )}
        >
          {m === 'beginner' ? 'Highlights' : 'Detailed Tape'}
        </button>
      ))}
    </div>
  )
}

export default function Masthead({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()

  const visibleSettings = settingsItems.filter(
    item => (!item.localOnly || LOCAL_FEATURES_ENABLED)
      && (!item.cloudOnly || !LOCAL_FEATURES_ENABLED)
      && (!item.adminOnly || isAdmin),
  )

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // Close the account menu on any route change so tapping a link dismisses it.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the menu on navigation
  useEffect(() => { setMenuOpen(false) }, [pathname])
  // Close on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const signOut = async () => {
    await createClient().auth.signOut()
    router.push('/')
    router.refresh()
  }

  const startTour = () => {
    setMenuOpen(false)
    window.dispatchEvent(new Event('tapescore:start-tour'))
  }

  // `today` is the PT session date, not machine-local — a mis-set OS timezone
  // on either synced machine would otherwise point these links at the wrong
  // calendar day. Tick every minute so links roll over across midnight PT.
  const [today, setToday] = useState<string>(() => todayPT())
  useEffect(() => {
    const id = setInterval(() => {
      const next = todayPT()
      setToday(prev => (prev === next ? prev : next))
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  // The date the review tabs default to when NOT on a dated route: today once
  // today's prep is started, else the most-recently-traded day.
  const [anchor, setAnchor] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/nav-anchor')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.anchor) setAnchor(d.anchor as string) })
      .catch(() => { /* fall back to today */ })
    return () => { cancelled = true }
  }, [pathname])

  // First-run orientation for new testers; hidden once onboarding completes and
  // always on the local owner build. Starts hidden so an established user never
  // sees it flash in and out on load.
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null)
  useEffect(() => {
    if (LOCAL_FEATURES_ENABLED) return
    let cancelled = false
    fetch('/api/onboarding')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setOnboardingCompleted(d?.onboarding?.status === 'completed') })
      .catch(() => { /* unknown → Welcome stays hidden */ })
    return () => { cancelled = true }
  }, [])
  const showWelcome = !LOCAL_FEATURES_ENABLED && onboardingCompleted === false

  // On a dated route the tabs stick to THAT date. Otherwise Prep points at
  // today (where you start today's prep) while the review tabs follow the
  // anchor, so they don't land on an empty today.
  //
  // `review/today` belongs in this list: the day recap used to live at
  // /eod/<date>, and when it moved under Review the pattern here was never
  // widened — so every dated recap page quietly dropped the date and threw you
  // back to today the moment you clicked another tab. Keep this in step with
  // the day-level routes; week and month are deliberately absent, since their
  // date is a period start, not the day you're looking at.
  const urlDate = (() => {
    const m = /^\/(?:prep|intraday|eod|review\/today)\/(\d{4}-\d{2}-\d{2})/.exec(pathname)
    return m ? m[1] : null
  })()
  const prepDate = urlDate ?? today
  const reviewDate = urlDate ?? anchor ?? today
  // Review keeps the day too, so Prep → Trade → Review is one day's loop rather
  // than three sections each with their own idea of the date. With no date in
  // play it stays bare, and /review picks the session to open on its own.
  const reviewHref = urlDate ? `/review/today/${urlDate}` : '/review'

  // `match` is the prefix that lights the item up — kept separate from href so
  // the dated links (/prep/2026-07-25) still match their section.
  // Dashboard is the home — the all-trades overview, front and centre, the first
  // thing everyone sees (it's also the signed-in landing). Then the daily loop:
  // Prep → Trade → Review (per-session debrief; EOD folds into Review·Today).
  // Calendar is gone as a destination — it's the Dashboard's list/calendar
  // toggle now.
  const navItems = [
    ...(showWelcome ? [{ href: '/welcome', label: 'Welcome', match: '/welcome' }] : []),
    { href: '/dashboard', label: 'Dashboard', match: '/dashboard' },
    { href: `/prep/${prepDate}`, label: 'Prep', match: '/prep' },
    { href: `/intraday/${reviewDate}`, label: 'Trade', match: '/intraday' },
    { href: reviewHref, label: 'Review', match: '/review' },
    { href: '/analytics', label: 'Patterns', match: '/analytics' },
  ]

  // Mobile bottom bar. Text-only, matching the masthead — the lucide icon set
  // is exactly what made the old rail read generic, and short labels are
  // legible at this size. Patterns lives in the More sheet to keep four primary
  // tabs.
  const mobileTabs = [
    { href: '/dashboard', label: 'Home', match: '/dashboard' },
    { href: `/prep/${prepDate}`, label: 'Prep', match: '/prep' },
    { href: `/intraday/${reviewDate}`, label: 'Trade', match: '/intraday' },
    { href: reviewHref, label: 'Review', match: '/review' },
  ]
  const moreNav = [
    ...(showWelcome ? [{ href: '/welcome', label: 'Welcome' }] : []),
    { href: '/analytics', label: 'Patterns' },
    { href: '/import', label: 'Import' },
  ]

  const [moreOpen, setMoreOpen] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the More sheet on any route change
  useEffect(() => { setMoreOpen(false) }, [pathname])

  // The current section's label, shown in place of the nav on narrow widths.
  const activeLabel = navItems.find(n => pathname.startsWith(n.match))?.label ?? ''

  return (
    <>
      {/* ── Desktop masthead (md+) ─────────────────────────────────────── */}
      <header className="hidden md:flex fixed top-0 inset-x-0 z-40 h-[62px] items-center gap-8 px-8 bg-gray-950 border-b border-gray-800">
        <BrandLockup href="/dashboard" />

        <nav className="flex items-center gap-0.5 flex-1 min-w-0">
          {navItems.map(({ href, label, match }) => {
            const active = pathname.startsWith(match)
            return (
              <Link
                key={label}
                href={href}
                data-tour={navTourAnchor(href)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'px-3 py-1.5 text-[13px] whitespace-nowrap border-b-2 -mb-px transition-colors',
                  active
                    ? 'text-gray-100 border-blue-500'
                    : 'text-gray-400 border-transparent hover:text-gray-100',
                )}
              >
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="flex items-center gap-5 flex-shrink-0">
          <Link
            href="/import"
            className={cn(
              'text-[13px] transition-colors',
              pathname.startsWith('/import') ? 'text-gray-100' : 'text-gray-400 hover:text-gray-100',
            )}
          >
            Import
          </Link>
          <ViewToggle />
          <ThemeToggle />

          {/* Account menu — settings, tour, sign out. */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(o => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className={cn(
                'flex items-center gap-1.5 text-[13px] transition-colors',
                menuOpen ? 'text-gray-100' : 'text-gray-400 hover:text-gray-100',
              )}
            >
              Account
              <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden className="flex-shrink-0">
                <path d="M1 1.2 4.5 4.7 8 1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-2 w-56 py-1.5 bg-gray-900 border border-gray-700 rounded-lg shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]"
              >
                {visibleSettings.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    role="menuitem"
                    className={cn(
                      'block px-4 py-2 text-[13px] transition-colors',
                      pathname.startsWith(href)
                        ? 'text-gray-100 bg-gray-800'
                        : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800',
                    )}
                  >
                    {label}
                  </Link>
                ))}
                {!LOCAL_FEATURES_ENABLED && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={startTour}
                    className="block w-full text-left px-4 py-2 text-[13px] text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
                  >
                    Take the tour
                  </button>
                )}
                <div className="my-1.5 border-t border-gray-800" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={signOut}
                  className="block w-full text-left px-4 py-2 text-[13px] text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Mobile top bar (md:hidden) — brand + section label + view toggle.
             Nav itself is the bottom tab bar, matching the mockup's narrow
             composition (masthead collapses, label + toggle kept). ──────── */}
      <div className="md:hidden fixed top-0 inset-x-0 h-14 z-30 flex items-center gap-3 px-4 bg-gray-950 border-b border-gray-800">
        <BrandLockup href="/dashboard" />
        {activeLabel && (
          <span className="text-[13px] font-semibold text-gray-100 truncate">{activeLabel}</span>
        )}
        <div className="ml-auto flex-shrink-0 flex items-center gap-2">
          <ThemeToggle compact />
          <ViewToggle compact />
        </div>
      </div>

      {/* ── Mobile bottom tab bar (md:hidden) ──────────────────────────── */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 flex bg-gray-950 border-t border-gray-800"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {mobileTabs.map(({ href, label, match }) => {
          const active = pathname.startsWith(match)
          return (
            <Link
              key={label}
              href={href}
              data-tour={navTourAnchor(href)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex-1 flex items-center justify-center py-2 min-h-[52px] text-[12px] border-t-2 -mt-px transition-colors',
                active
                  ? 'text-gray-100 font-semibold border-blue-500'
                  : 'text-gray-400 border-transparent hover:text-gray-200',
              )}
            >
              {label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          className={cn(
            'flex-1 flex items-center justify-center py-2 min-h-[52px] text-[12px] border-t-2 -mt-px transition-colors',
            moreOpen
              ? 'text-gray-100 font-semibold border-blue-500'
              : 'text-gray-400 border-transparent hover:text-gray-200',
          )}
        >
          More
        </button>
      </nav>

      {/* ── Mobile "More" sheet — secondary nav + settings + sign out ───── */}
      {moreOpen && (
        <div className="md:hidden">
          <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setMoreOpen(false)} aria-hidden />
          <div
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-gray-900 border-t border-gray-700"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="sticky top-0 flex items-center justify-between px-5 py-4 bg-gray-900 border-b border-gray-800">
              <span className="text-sm font-semibold text-gray-200">More</span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                className="text-[13px] text-gray-400 hover:text-gray-100"
              >
                Close
              </button>
            </div>

            <div className="py-2">
              {moreNav.map(({ href, label }) => (
                <Link
                  key={label}
                  href={href}
                  className={cn(
                    'block px-5 py-3 text-sm transition-colors',
                    pathname.startsWith(href)
                      ? 'text-gray-100 bg-gray-800'
                      : 'text-gray-300 hover:text-gray-100 hover:bg-gray-800',
                  )}
                >
                  {label}
                </Link>
              ))}
            </div>

            {visibleSettings.length > 0 && (
              <div className="py-2 border-t border-gray-800">
                <p className="px-5 pb-1 pt-1 text-[11px] text-gray-500">Settings</p>
                {visibleSettings.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      'block px-5 py-3 text-sm transition-colors',
                      pathname.startsWith(href)
                        ? 'text-gray-100 bg-gray-800'
                        : 'text-gray-300 hover:text-gray-100 hover:bg-gray-800',
                    )}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            )}

            <div className="py-2 border-t border-gray-800">
              {!LOCAL_FEATURES_ENABLED && (
                <button
                  type="button"
                  onClick={startTour}
                  className="block w-full text-left px-5 py-3 text-sm text-gray-300 hover:text-gray-100 hover:bg-gray-800 transition-colors"
                >
                  Take the tour
                </button>
              )}
              <button
                type="button"
                onClick={signOut}
                className="block w-full text-left px-5 py-3 text-sm text-gray-300 hover:text-gray-100 hover:bg-gray-800 transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
