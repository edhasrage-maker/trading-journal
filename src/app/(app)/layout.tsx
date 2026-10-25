import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import Masthead from '@/components/Masthead'
import AppMain from '@/components/AppMain'
import CoachChat from '@/components/CoachChat'
import OnboardingGate from '@/components/onboarding/OnboardingGate'
import DemoBanner from '@/components/DemoBanner'
import { UiModeProvider } from '@/lib/ui-mode'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { isDemoEmail } from '@/lib/demo'
import { dayStatsRequest, warmDayStats } from '@/lib/day-stats-batch'
import { recordAppVisit } from '@/lib/funnel'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')
  // Admin = the local power-user build (you, single user), OR a hosted user
  // whose email matches ADMIN_EMAIL. Regular hosted users get only Coaching +
  // Tags in Settings; the admin also gets Condition Lookup / Bar Data / SC
  // Archives (the latter two only in the local build — they need `.scid`).
  const isAdmin = LOCAL_FEATURES_ENABLED || (!!user.email && user.email === process.env.ADMIN_EMAIL)
  const isDemo = !LOCAL_FEATURES_ENABLED && isDemoEmail(user.email)

  // Once this page is sent: rebuild any stale dashboard rollups. A deploy that
  // changes the rollup (STATS_VERSION) dirties every day at once; doing it here
  // means the first page load after the deploy absorbs it, not the next
  // dashboard click. Layouts render on full page loads only — which is what the
  // first navigation after a deploy is. The dashboard rebuilds its own (it has
  // to render them); the demo account is read-only.
  const statsRequest = dayStatsRequest()
  if (!isDemo) {
    after(async () => {
      if (!statsRequest.rebuiltByPage) await warmDayStats(supabase, user.id)
    })
  }
  // Launch funnel (hosted): the sign-up milestone, and "came back" from the
  // next day on. Skips the demo, the admin and the local build by itself.
  after(() => recordAppVisit(supabase, user))

  return (
    <UiModeProvider>
      <div className="flex flex-col min-h-screen">
        <Masthead isAdmin={isAdmin} />
        <AppMain>
          {isDemo && <DemoBanner />}
          {/* Cloud-only setup nudge; the local owner's app is untouched. The
              demo account skips onboarding (it's read-only, pre-seeded). */}
          {!LOCAL_FEATURES_ENABLED && !isDemo && <OnboardingGate />}
          {children}
        </AppMain>
        {/* Floating Trade Coach — bottom-right icon on every page; click to
            expand. Wrapped in #coach-fab-root so globals.css can lift the FAB
            above the mobile bottom tab bar without editing CoachChat.tsx. */}
        <div id="coach-fab-root">
          <CoachChat isDemo={isDemo} />
        </div>
      </div>
    </UiModeProvider>
  )
}
