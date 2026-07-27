'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { driver, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { todayPT } from '@/lib/pt-time'
import {
  TOUR_VERSION,
  TOUR_STEPS,
  type TourStep,
  populatedRoutes,
  stepRouteMatches,
  stepsForPathname,
} from '@/lib/site-tour'

/**
 * First-login guided tour engine (driver.js). Mounted once inside OnboardingGate
 * — which lives in the persistent (app) layout — so a single instance survives
 * client navigations and can drive a MULTI-PAGE tour: it walks the current
 * route's steps, then navigates to the next populated route and resumes there.
 *
 * Cloud-only (the owner's local build never sees it). Auto-starts once on the
 * first /dashboard visit when the user has no tour_status yet, and persists
 * done/skipped to trader_profile.onboarding_json so it never nags again. Also
 * listens for a 'tapescore:start-tour' window event so a "?" button can re-run
 * it on demand.
 */

const START_EVENT = 'tapescore:start-tour'
const ANCHOR_TIMEOUT_MS = 2500

/** Is the element actually on-screen? Handles the desktop-sidebar-vs-mobile-tab
 *  duplicate anchors (the hidden one has display:none / zero box) AND fixed
 *  elements like the coach FAB (offsetParent is null for those, so we can't use
 *  it — we check the computed box + styles instead). */
function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const s = window.getComputedStyle(el)
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
}

/** Resolve a step to its currently-visible target element (or null for a
 *  centered/modal step or a not-yet-mounted anchor). */
function resolveEl(step: TourStep): HTMLElement | null {
  const sel = step.selector ?? (step.anchor ? `[data-tour="${step.anchor}"]` : null)
  if (!sel) return null
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel))
  return nodes.find(isVisible) ?? nodes[0] ?? null
}

/** Bare '/prep' → '/prep/<today>'; non-dated routes pass through. */
function concretePath(route: string): string {
  if (route === '/prep' || route === '/eod' || route === '/intraday') return `${route}/${todayPT()}`
  return route
}

/** The next populated route after the one covering `pathname`, or null if this
 *  is the last chapter. */
function nextRouteAfter(pathname: string): string | null {
  const routes = populatedRoutes()
  const idx = routes.findIndex(r => stepRouteMatches(r, pathname))
  if (idx < 0) return null
  return routes[idx + 1] ?? null
}

export default function SiteTour() {
  const pathname = usePathname()
  const router = useRouter()
  const [active, setActive] = useState(false)

  // Refs so the driver.js callbacks (created once per chapter) never read a
  // stale pathname / active flag.
  const activeRef = useRef(false)
  const pathnameRef = useRef(pathname)
  useEffect(() => { pathnameRef.current = pathname }, [pathname])
  const driverRef = useRef<Driver | null>(null)
  const endingRef = useRef(false)      // guards close-handlers during a controlled teardown
  const drivingRef = useRef<string | null>(null) // pathname whose chapter is being driven
  const startAttemptedRef = useRef(false)

  const setActiveBoth = useCallback((v: boolean) => {
    activeRef.current = v
    setActive(v)
  }, [])

  // Persist the outcome and tear down. status: 'done' | 'skipped'.
  const finish = useCallback((status: 'done' | 'skipped') => {
    endingRef.current = true
    try { driverRef.current?.destroy() } catch { /* already gone */ }
    driverRef.current = null
    drivingRef.current = null
    setActiveBoth(false)
    fetch('/api/onboarding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        onboarding: { tour_status: status, tour_version: TOUR_VERSION, tour_seen_at: new Date().toISOString() },
      }),
    }).catch(() => { /* best-effort; not worth blocking on */ })
  }, [setActiveBoth])

  // Called when the user advances past a chapter's last step. Navigate to the
  // next populated route (the resume effect drives it) or finish the tour.
  const endChapter = useCallback(() => {
    const next = nextRouteAfter(pathnameRef.current)
    if (!next) { finish('done'); return }
    endingRef.current = true
    try { driverRef.current?.destroy() } catch { /* already gone */ }
    driverRef.current = null
    drivingRef.current = null
    router.push(concretePath(next))
  }, [finish, router])

  // Wait (rAF loop) until a chapter's first anchor is on-screen, then run it.
  const driveChapter = useCallback((steps: TourStep[], forPathname: string) => {
    const isLastChapter = nextRouteAfter(forPathname) == null
    const d = driver({
      showProgress: true,
      allowClose: true,
      stagePadding: 6,
      stageRadius: 10,
      overlayColor: '#030712',
      overlayOpacity: 0.72,
      popoverClass: 'tapescore-tour',
      nextBtnText: 'Next →',
      prevBtnText: '← Back',
      doneBtnText: isLastChapter ? 'Finish ✓' : 'Next →',
      onNextClick: () => {
        const inst = driverRef.current
        if (inst?.isLastStep()) endChapter()
        else inst?.moveNext()
      },
      onPrevClick: () => driverRef.current?.movePrevious(),
      onCloseClick: () => finish('skipped'),
      // Overlay-click / ESC also route through here. During a controlled
      // teardown (endChapter/finish) endingRef is set, so we just let it die.
      onDestroyStarted: () => {
        if (endingRef.current) { driverRef.current?.destroy(); return }
        finish('skipped')
      },
      // Add an explicit, obvious "Skip tour" affordance beyond the X.
      onPopoverRender: popover => {
        if (popover.footer.querySelector('.ts-tour-skip')) return
        const skip = document.createElement('button')
        skip.type = 'button'
        skip.className = 'ts-tour-skip'
        skip.textContent = 'Skip tour'
        skip.addEventListener('click', () => finish('skipped'))
        popover.footer.prepend(skip)
      },
      steps: steps.map(s => ({
        element: resolveEl(s) ?? undefined,
        popover: { title: s.title, description: s.description, side: s.side, align: s.align },
      })),
    })
    driverRef.current = d
    endingRef.current = false
    d.drive()
  }, [endChapter, finish])

  // Auto-start: once, on a /dashboard visit, if no tour_status yet AND the
  // journal has data.
  //
  // The data gate is the point (Pt 16). The tour walks Dashboard → Prep →
  // Review → Analytics; on a brand-new account every one of those is empty, so
  // it narrated "every trade you took, with the stats that matter" over blank
  // screens — right when the trader should have been looking at the one thing
  // that mattered, the import card. So it now waits for the first trade.
  //
  // Deliberately NOT re-armed by the import itself: EmptyStateImport finishes
  // with router.refresh(), which doesn't change the pathname, so the tour holds
  // off and the post-import "first read" payoff gets the screen to itself. It
  // starts on the next visit to the dashboard. `startAttemptedRef` is only
  // latched once we actually start, so that later visit still gets its chance.
  useEffect(() => {
    if (LOCAL_FEATURES_ENABLED) return
    if (startAttemptedRef.current) return
    if (!pathname || pathname !== '/dashboard') return
    let cancelled = false
    ;(async () => {
      const ob = await fetch('/api/onboarding').then(r => r.json()).catch(() => null)
      if (cancelled || !ob) return
      if (ob.onboarding?.tour_status) return // already done/skipped
      if (TOUR_STEPS.length === 0) return
      const nav = await fetch('/api/nav-anchor').then(r => r.json()).catch(() => null)
      if (cancelled) return
      if (!nav || nav.lastTradeDate == null) return // empty journal — import first
      startAttemptedRef.current = true
      setActiveBoth(true)
    })()
    return () => { cancelled = true }
  }, [pathname, setActiveBoth])

  // Manual re-run from a "?" button etc. Starts the tour and jumps to the first
  // populated route.
  useEffect(() => {
    const onStart = () => {
      const first = populatedRoutes()[0]
      if (!first) return
      setActiveBoth(true)
      const target = concretePath(first)
      if (pathnameRef.current !== target && !stepRouteMatches(first, pathnameRef.current)) {
        router.push(target)
      }
    }
    window.addEventListener(START_EVENT, onStart)
    return () => window.removeEventListener(START_EVENT, onStart)
  }, [router, setActiveBoth])

  // Drive / resume: whenever the tour is active and we land on a route that has
  // steps, run its chapter (once). Waits for the first anchor to mount first.
  useEffect(() => {
    if (!active || !pathname) return
    if (drivingRef.current === pathname) return // already driving this chapter
    const steps = stepsForPathname(pathname)
    if (steps.length === 0) return // intermediate route; wait for the target
    drivingRef.current = pathname

    let cancelled = false
    const first = steps[0]
    const startedAt = performance.now()
    const waitAndDrive = () => {
      if (cancelled) return
      const ready = !first.anchor && !first.selector ? true : resolveEl(first) != null
      if (ready || performance.now() - startedAt > ANCHOR_TIMEOUT_MS) {
        if (!cancelled) driveChapter(steps, pathname)
        return
      }
      requestAnimationFrame(waitAndDrive)
    }
    waitAndDrive()

    return () => { cancelled = true }
  }, [active, pathname, driveChapter])

  // Tear down on unmount (route away from the whole app, sign-out, etc.).
  useEffect(() => () => { try { driverRef.current?.destroy() } catch { /* noop */ } }, [])

  return null
}
