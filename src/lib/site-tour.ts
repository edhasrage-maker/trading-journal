// First-login guided tour — the step manifest + small pure helpers. The engine
// that drives these (driver.js) lives in components/tour/SiteTour.tsx.
//
// Steps are ORDERED and grouped by route. The engine drives one route's chapter
// at a time and, when a chapter ends, navigates to the next route that still has
// steps (see TOUR_ROUTE_ORDER). New pages can be added just by appending steps —
// the engine adapts to whichever routes are populated.
//
// Anchoring: a step targets an element by `anchor` (a data-tour="<name>"
// attribute, resolved to the VISIBLE match at drive time so the desktop sidebar
// vs the mobile tab bar each work) or a raw `selector` (e.g. the coach FAB).
// A step with neither renders as a centered modal — used for the intro.

/** Bump when the tour changes enough that we'd want returning users to see it
 *  again. Stored alongside tour_status so a future "re-show on major update"
 *  can compare. */
export const TOUR_VERSION = 1

export interface TourStep {
  /** Route this step belongs to. Dated routes match by prefix, so '/prep'
   *  covers '/prep/2026-07-04'. '/dashboard' matches exactly. */
  route: string
  /** data-tour anchor name — resolved to the visible element at drive time. */
  anchor?: string
  /** Raw CSS selector, used when there's no data-tour hook (e.g. '#coach-fab-root'). */
  selector?: string
  title: string
  description: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

/** The sequence of routes the tour walks. The engine navigates from one to the
 *  next populated route when a chapter finishes. Dated routes are bare prefixes
 *  here; the engine appends the actual date (todayPT) when navigating. */
export const TOUR_ROUTE_ORDER = ['/dashboard', '/prep', '/eod', '/analytics'] as const

export const TOUR_STEPS: TourStep[] = [
  // ---------------------------------------------------------------- Dashboard
  {
    route: '/dashboard',
    title: 'Welcome to TapeScore 👋',
    description:
      "Quick 30-second tour so you know where everything lives and what it does. You can leave any time with “Skip tour”.",
  },
  {
    route: '/dashboard',
    anchor: 'dash-import',
    title: 'Start with your trades',
    description:
      'Import a CSV or Sierra Chart file — or log a trade by hand — and your dashboard fills in: P&L, win rate, your best and worst days. Everything else is built from these trades.',
    side: 'top',
    align: 'center',
  },
  {
    route: '/dashboard',
    selector: '#coach-fab-root',
    title: 'Your Trade Coach',
    description:
      'Ask anything about your trading in plain English — “What are my patterns when I trade poorly?” It answers from YOUR logged trades, not generic advice.',
    side: 'left',
    align: 'end',
  },
]

/** True when a step's route covers the current pathname. Dated routes match by
 *  prefix ('/prep' → '/prep/2026-07-04'); '/dashboard' matches exactly. */
export function stepRouteMatches(stepRoute: string, pathname: string): boolean {
  if (stepRoute === '/dashboard') return pathname === '/dashboard'
  return pathname === stepRoute || pathname.startsWith(stepRoute + '/')
}

/** The ordered list of routes that actually have steps, in TOUR_ROUTE_ORDER. */
export function populatedRoutes(): string[] {
  return TOUR_ROUTE_ORDER.filter(r => TOUR_STEPS.some(s => s.route === r))
}

/** Steps for the route covering `pathname`, in manifest order. */
export function stepsForPathname(pathname: string): TourStep[] {
  return TOUR_STEPS.filter(s => stepRouteMatches(s.route, pathname))
}
