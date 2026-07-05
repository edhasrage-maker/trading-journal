import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import AppMain from '@/components/AppMain'
import CoachChat from '@/components/CoachChat'
import OnboardingGate from '@/components/onboarding/OnboardingGate'
import DemoBanner from '@/components/DemoBanner'
import { UiModeProvider } from '@/lib/ui-mode'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { isDemoEmail } from '@/lib/demo'

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

  return (
    <UiModeProvider>
      <div className="flex min-h-screen">
        <Sidebar isAdmin={isAdmin} />
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
