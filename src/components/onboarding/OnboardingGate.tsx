'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Sparkles, X } from 'lucide-react'
import SiteTour from '@/components/tour/SiteTour'

const WEEK_REMINDER_MS = 5 * 24 * 3600 * 1000 // ~end of first week after the first dismissal
const TAG_NUDGE_MS = 14 * 24 * 3600 * 1000 // re-ask about an empty playbook ~every two weeks
const PLAYBOOK_CATS = ['setups', 'confluences', 'entry_model', 'order_flow']

/**
 * Offers the setup wizard and the playbook nudge — without either one landing
 * before the trader has seen the product work.
 *
 *  NOTHING SHOWS ON AN EMPTY JOURNAL (Pt 16). Value first, profile second: an
 *  account with no trades gets the empty-state import card and nothing else.
 *  Both prompts below wait for `nav-anchor.lastTradeDate`, i.e. the first
 *  imported or logged trade.
 *
 *  Setup banner (onboarding not completed, once there's data):
 *  - a dismissible banner. After the first dismissal it stays gone until ~a
 *    week later, when it returns exactly once (the end-of-week reminder), then
 *    never again.
 *  - completed → no setup banner.
 *
 *  Empty-tags nudge (any user, even completed): while the tag library has ZERO
 *  playbook tags (setups + confluences + entry_model + order_flow), re-ask
 *  ~every 14 days whether they want to add setups. Self-terminating — the moment
 *  any playbook tag exists the check fails and it never shows again. A permanent
 *  "Don't ask again" opt-out is offered. The first eligibility silently starts
 *  the clock (a 14-day grace) so a user who just chose the light path isn't
 *  nagged immediately. The setup banner takes priority so only one shows at once.
 *
 * All state lives in onboarding_json so it's per-user across devices.
 */
export default function OnboardingGate() {
  const pathname = usePathname()
  const [banner, setBanner] = useState<'none' | 'setup' | 'tags'>('none')
  const [resume, setResume] = useState(false)

  useEffect(() => {
    if (pathname?.startsWith('/welcome')) return // never interfere on the wizard/capture pages
    let cancelled = false
    ;(async () => {
      const ob = await fetch('/api/onboarding').then(r => r.json()).catch(() => null)
      if (cancelled || !ob) return
      const o = ob.onboarding ?? {}
      const status = o.status as string | undefined

      // Has the journal got anything in it yet? An empty account has exactly ONE
      // job — get trades in — and the empty-state import card owns that screen.
      // Anything we add there is a second CTA competing with it before the
      // product has shown the trader a single thing. (This used to HARD-REDIRECT
      // a brand-new empty account into the profile wizard, which inverted the
      // whole promise: four screens about your setups and risk rails before
      // you'd seen one number of your own.)
      //
      // Checked lazily and only once, right before something is about to show:
      // this effect runs on every navigation, and the Masthead already fetches
      // nav-anchor on each one, so an unconditional second call would be a
      // per-page-view cost paid by every established user for nothing.
      let trades: boolean | null = null
      const hasTrades = async (): Promise<boolean> => {
        if (trades == null) {
          const nav = await fetch('/api/nav-anchor').then(r => r.json()).catch(() => null)
          trades = !!nav && nav.lastTradeDate != null
        }
        return trades
      }

      // --- Setup banner (onboarding not completed) ---
      if (status !== 'completed') {
        // A dismissible banner, with one end-of-week reminder.
        const dismissedAt = o.banner_dismissed_at ? new Date(o.banner_dismissed_at).getTime() : null
        const reminded = o.week_reminder_shown === true
        let visible = false
        if (dismissedAt == null) visible = true
        else if (!reminded && (Date.now() - dismissedAt) >= WEEK_REMINDER_MS) visible = true
        if (visible) {
          if (!(await hasTrades()) || cancelled) return
          setBanner('setup'); setResume(status === 'in_progress'); return
        }
      }

      // --- Empty-tags nudge (any user, only while the playbook is empty) ---
      if (o.tag_nudge_optout === true) return
      const tags = await fetch('/api/trade-tags').then(r => r.json()).catch(() => null)
      if (cancelled || !Array.isArray(tags)) return
      const hasPlaybook = tags.some((t: { category?: string }) => t.category && PLAYBOOK_CATS.includes(t.category))
      if (hasPlaybook) return // self-terminating: any playbook tag ends the nudge for good

      const last = o.tag_nudge_last_at ? new Date(o.tag_nudge_last_at).getTime() : null
      if (last == null) {
        // First time eligible — start the clock silently (14-day grace), don't
        // nag yet. Gated on data too, so the grace starts from the trader's
        // first real session rather than from an empty sign-up.
        if (!(await hasTrades()) || cancelled) return
        fetch('/api/onboarding', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ onboarding: { tag_nudge_last_at: new Date().toISOString() } }),
        }).catch(() => {})
        return
      }
      if ((Date.now() - last) >= TAG_NUDGE_MS) {
        if (!(await hasTrades()) || cancelled) return
        setBanner('tags')
      }
    })()
    return () => { cancelled = true }
  }, [pathname])

  const patch = (onboarding: Record<string, unknown>) =>
    fetch('/api/onboarding', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding }),
    }).catch(() => {})

  const dismissSetup = async () => {
    setBanner('none')
    // First dismissal records the timestamp; dismissing the later reminder marks
    // it done so the banner never returns.
    const ob = await fetch('/api/onboarding').then(r => r.json()).catch(() => null)
    const already = ob?.onboarding?.banner_dismissed_at
    await patch(already ? { week_reminder_shown: true } : { banner_dismissed_at: new Date().toISOString() })
  }

  // Snooze restarts the ~14-day clock; opt-out silences it forever.
  const snoozeTags = () => { setBanner('none'); patch({ tag_nudge_last_at: new Date().toISOString() }) }
  const optOutTags = () => { setBanner('none'); patch({ tag_nudge_optout: true }) }

  // SiteTour is always mounted (it self-gates on cloud-mode + tour_status) so the
  // guided tour survives route changes from this persistent-layout mount point.
  return (
    <>
      <SiteTour />
      {banner === 'setup' && (
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
          <button type="button" onClick={dismissSetup} aria-label="Dismiss" className="shrink-0 text-amber-500/70 hover:text-amber-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {banner === 'tags' && (
        <div className="flex items-center gap-3 px-4 py-2.5 mb-5 bg-amber-950/40 border border-amber-900/60 rounded-lg text-sm">
          <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-amber-100/90">Your playbook&apos;s still empty — add the setups you trade so your coach can grade them.</span>
          <Link href="/welcome/playbook" className="ml-auto shrink-0 text-amber-200 font-medium hover:underline">Add setups</Link>
          <button type="button" onClick={optOutTags} className="shrink-0 text-amber-500/70 hover:text-amber-300 text-xs">Don&apos;t ask again</button>
          <button type="button" onClick={snoozeTags} aria-label="Dismiss" className="shrink-0 text-amber-500/70 hover:text-amber-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  )
}
