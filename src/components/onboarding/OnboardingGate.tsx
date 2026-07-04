'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Sparkles, X } from 'lucide-react'
import SiteTour from '@/components/tour/SiteTour'

const WEEK_REMINDER_MS = 5 * 24 * 3600 * 1000 // ~end of first week after the first dismissal

/**
 * Puts the setup wizard in front of users without forcing it on people who
 * already have data:
 *  - Brand-new account (no onboarding status, no trades) landing on /dashboard
 *    → open the wizard once. Only from the dashboard, so deliberate navigation
 *    is never hijacked, and only when empty so existing testers are untouched.
 *  - skipped / in_progress / new-but-has-data → a dismissible banner. After the
 *    first dismissal it stays gone until ~a week later, when it returns exactly
 *    once (the end-of-week reminder), then never again.
 *  - completed → nothing.
 * Dismissal state lives in onboarding_json so it's per-user across devices.
 */
export default function OnboardingGate() {
  const pathname = usePathname()
  const router = useRouter()
  const [show, setShow] = useState(false)
  const [resume, setResume] = useState(false)

  useEffect(() => {
    if (pathname?.startsWith('/welcome')) return // never interfere on the wizard itself
    let cancelled = false
    ;(async () => {
      const ob = await fetch('/api/onboarding').then(r => r.json()).catch(() => null)
      if (cancelled || !ob) return
      const o = ob.onboarding ?? {}
      const status = o.status as string | undefined
      if (status === 'completed') return

      // Brand-new + empty → auto-open the wizard, but only from the dashboard.
      if (!status && pathname === '/dashboard') {
        const nav = await fetch('/api/nav-anchor').then(r => r.json()).catch(() => null)
        if (cancelled) return
        if (nav && nav.lastTradeDate == null) { router.replace('/welcome/setup'); return }
      }

      // Otherwise a dismissible banner, with one end-of-week reminder.
      const dismissedAt = o.banner_dismissed_at ? new Date(o.banner_dismissed_at).getTime() : null
      const reminded = o.week_reminder_shown === true
      let visible = false
      if (dismissedAt == null) visible = true
      else if (!reminded && (Date.now() - dismissedAt) >= WEEK_REMINDER_MS) visible = true
      if (!cancelled && visible) { setShow(true); setResume(status === 'in_progress') }
    })()
    return () => { cancelled = true }
  }, [pathname, router])

  const dismiss = async () => {
    setShow(false)
    // First dismissal records the timestamp; dismissing the later reminder marks
    // it done so the banner never returns.
    const ob = await fetch('/api/onboarding').then(r => r.json()).catch(() => null)
    const already = ob?.onboarding?.banner_dismissed_at
    await fetch('/api/onboarding', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding: already ? { week_reminder_shown: true } : { banner_dismissed_at: new Date().toISOString() } }),
    }).catch(() => {})
  }

  // SiteTour is always mounted (it self-gates on cloud-mode + tour_status) so the
  // guided tour survives route changes from this persistent-layout mount point.
  // The setup banner renders only when `show`.
  return (
    <>
      <SiteTour />
      {show && (
        <div className="flex items-center gap-3 px-4 py-2.5 mb-5 bg-amber-950/40 border border-amber-900/60 rounded-lg text-sm">
          <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-amber-100/90">
            {resume
              ? 'Pick up where you left off — finish setting up your coaching profile.'
              : 'Tell your coach how you trade so it can grade the way you do.'}
          </span>
          <Link href="/welcome/setup" className="ml-auto shrink-0 text-amber-200 font-medium hover:underline">
            {resume ? 'Resume setup' : 'Set up profile'}
          </Link>
          <button type="button" onClick={dismiss} aria-label="Dismiss" className="shrink-0 text-amber-500/70 hover:text-amber-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  )
}
