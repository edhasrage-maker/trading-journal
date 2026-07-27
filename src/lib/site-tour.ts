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
export const TOUR_ROUTE_ORDER = ['/dashboard', '/prep', '/review/today', '/analytics'] as const

export const TOUR_STEPS: TourStep[] = [
  // ---------------------------------------------------------------- Dashboard
  {
    route: '/dashboard',
    title: 'Welcome to TapeScore 👋',
    description:
      "A 30-second walk through where everything lives and what it does. You can leave any time with “Skip tour”.",
  },
  {
    route: '/dashboard',
    // Anchors the empty-state import card when it's on screen; on a populated
    // dashboard there's no such element and the engine renders this as a
    // centered card instead (resolveEl → undefined). The copy has to read
    // correctly BOTH ways — the tour only auto-starts once there are trades,
    // but a manual re-run can still land on an empty dashboard.
    anchor: 'dash-import',
    title: 'It all starts with your trades',
    description:
      'Everything here is built from your fills — P&L, win rate, your best and worst days, every pattern below. Add more any time from Import in the top bar (a CSV from your broker, or a Sierra Chart log), or log a trade by hand.',
    side: 'top',
    align: 'center',
  },
  {
    route: '/dashboard',
    // Target the actual FAB button, not the #coach-fab-root wrapper: the wrapper's
    // only child is position:fixed, so the wrapper itself collapses to a 0-height
    // strip in normal flow — driver.js would spotlight that (invisible) and drop
    // the popover over the real brain icon. The button carries the fixed
    // bottom-right box we want highlighted. 'top' keeps the popover clear of the
    // corner FAB on both desktop and mobile.
    selector: '#coach-fab-root > button',
    title: 'Your Trade Coach',
    description:
      'Ask anything about your trading in plain English — “What are my patterns when I trade poorly?” It answers from YOUR logged trades, not generic advice.',
    side: 'top',
    align: 'end',
  },
  {
    route: '/dashboard',
    anchor: 'nav-prep',
    title: 'Next: plan your day',
    description:
      "Daily Prep is where you set your bias and levels before the session. Click Next and we'll head there →",
  },
  // --------------------------------------------------------------------- Prep
  {
    route: '/prep',
    anchor: 'prep-header',
    title: 'Daily Prep',
    description:
      'Plan the day before you trade — your bias, key levels, and what would make you wrong. Your coach reads this too, so a good plan means sharper feedback.',
    side: 'bottom',
    align: 'start',
  },
  {
    route: '/prep',
    anchor: 'prep-chart',
    title: 'Your chart & levels',
    description:
      'Live bars with the session levels auto-marked. Mark up your spots here so you know them cold before the open.',
    side: 'top',
    align: 'center',
  },
  {
    route: '/prep',
    anchor: 'nav-eod',
    title: 'Next: review your day',
    description:
      'After the session, EOD Recap is where you grade what you actually did. Click Next →',
  },
  // ---------------------------------------------------------------------- EOD
  {
    route: '/review/today',
    anchor: 'eod-header',
    title: 'EOD Recap',
    description:
      'Every trade you took, with the stats that matter — how much of the move you captured, the heat you took, and your MFE:MAE. This is your game film.',
    side: 'bottom',
    align: 'start',
  },
  {
    route: '/review/today',
    anchor: 'eod-analyze',
    title: 'Grade your execution',
    description:
      'One click gives you an AI read on how well you followed your plan and your rules — the process, not just the P&L.',
    side: 'top',
    align: 'center',
  },
  {
    route: '/review/today',
    anchor: 'nav-analytics',
    title: 'Next: the big picture',
    description:
      'Analytics rolls up every trade to show where your real edge is. Last stop — click Next →',
  },
  // ---------------------------------------------------------------- Analytics
  {
    route: '/analytics',
    anchor: 'analytics-header',
    title: 'Analytics',
    description:
      'Your edge across every trade — win rate and expectancy broken down by setup, structure, day type, and more.',
    side: 'bottom',
    align: 'start',
  },
  {
    route: '/analytics',
    anchor: 'analytics-range',
    title: 'Slice it your way',
    description:
      "Filter by time window and the tables below update. That's the tour — you're all set. Import some trades and start exploring!",
    side: 'bottom',
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
