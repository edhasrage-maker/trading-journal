'use client'

/**
 * Settings → Trading Rules — the post-onboarding home for the structured rails
 * and rules the deterministic Coach Score grades against
 * (trader_profile.scoring_profile_json). The only editor used to be the
 * first-run wizard's Rules step, which an existing user has no reason to
 * revisit (founder, 2026-08-05: "shouldn't the rules be somewhere in the user
 * settings"). Reuses that same step in settings mode: it loads the CURRENT
 * profile, so toggling one rail off saves with every other rail intact.
 *
 * NB the Player Profile (Settings → Player Profile) free text is the coach's
 * NARRATIVE context — editing it does not change grading. This page is the one
 * that does. Keep the two consistent by hand for now.
 */
import { useState } from 'react'
import RulesStep from '@/components/onboarding/RulesStep'

export default function RulesSettingsPage() {
  const [saved, setSaved] = useState(false)
  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-2">Trading Rules</h1>
      <p className="text-gray-400 text-sm mb-2">
        The structured rails your Coach Score actually grades against — daily loss limit,
        size caps, trade cap, cooldown, no-add-to-loser. Turn a rule off and it stops being
        scored; the rules-passed verdict adapts to the set you keep.
      </p>
      <p className="text-gray-500 text-xs mb-8">
        This is different from your Player Profile, which is free-text context for the
        coach&apos;s commentary — changing prose there does not change grading.
      </p>
      <RulesStep mode="settings" onNext={() => setSaved(true)} onSkipAll={() => {}} />
      {saved && (
        <p className="text-sm text-emerald-400 mt-4">
          Saved — the next Analyze Session grades against the updated rules. Re-run analysis
          on an existing day to re-grade it.
        </p>
      )}
    </div>
  )
}
