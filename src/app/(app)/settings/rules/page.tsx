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
 * Below it, the one TapeScore setting that lives in the same profile: whether
 * the order-flow Score counts toward Entry (amendment 9; on unless switched
 * off). It saves on its own, the moment it is flipped — the score is worked out
 * when a page loads, so nothing needs re-analysing.
 *
 * Below that, the trader's entry rules (EntryRulesSetting) — graded on every
 * trade from the tick tape and counted in Entry — and their runner rules
 * (RunnerRulesSetting), graded from their fills and counted in Exit.
 *
 * NB the Player Profile (Settings → Player Profile) free text is the coach's
 * NARRATIVE context — editing it does not change grading. This page is the one
 * that does. Keep the two consistent by hand for now.
 */
import { useEffect, useState } from 'react'
import RulesStep from '@/components/onboarding/RulesStep'
import EntryRulesSetting from '@/components/settings/EntryRulesSetting'
import RunnerRulesSetting from '@/components/settings/RunnerRulesSetting'
import { includeFlowScoreInEntry, type ScoringProfile } from '@/lib/scoring-profile'

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
      <FlowScoreSetting />
      <EntryRulesSetting />
      <RunnerRulesSetting />
    </div>
  )
}

/** "Include the order-flow Score in my Entry grade" — saved on flip. */
function FlowScoreSetting() {
  const [on, setOn] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/onboarding').then(r => r.json()).then(d => {
      if (!cancelled) setOn(includeFlowScoreInEntry((d?.scoring_profile ?? null) as ScoringProfile | null))
    }).catch(() => { if (!cancelled) setOn(includeFlowScoreInEntry(null)) })
    return () => { cancelled = true }
  }, [])

  const flip = async () => {
    if (on == null || saving) return
    const next = !on
    setOn(next); setSaving(true); setError(null)
    try {
      // The profile route merges top-level keys, so this touches nothing else.
      const res = await fetch('/api/onboarding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoring_profile: { tapescore: { entry_flow_score: next } } }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not save.')
    } catch (e) {
      setOn(!next)
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally { setSaving(false) }
  }

  return (
    <div className="mt-10 pt-6 border-t border-gray-800">
      <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-3">TapeScore</p>
      <div className="border border-gray-800 rounded-lg p-4">
        <button type="button" onClick={flip} disabled={on == null || saving} role="switch" aria-checked={on ?? false}
          className="flex items-start gap-2 text-left disabled:opacity-60">
          <span className={`mt-0.5 w-9 h-5 rounded-full transition-colors flex items-center px-0.5 shrink-0 ${on ? 'bg-blue-600' : 'bg-gray-700'}`}>
            <span className={`w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
          </span>
          <span>
            <span className="text-sm text-gray-200">Include the order-flow Score in my Entry grade</span>
            <span className="block text-[11px] text-gray-500 mt-0.5">
              On by default — your trades&apos; order-flow Scores make up 35% of Entry, and trades without a Score are simply left out.
            </span>
          </span>
        </button>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </div>
    </div>
  )
}
