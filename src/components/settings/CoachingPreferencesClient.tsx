'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save, AlertCircle, CheckCircle2, Brain, Lightbulb, Target } from 'lucide-react'

const FOCUS_PLACEHOLDER = `A short, high-priority list of what the coach should weight MOST right now. This is injected last — right before your question — so it gets the most attention. Keep it to a few sharp bullets:

- Lead with my risk management: compare MAE planned (stop) vs MAE taken (actual heat), and my win rate by heat taken.
- Watch my post-loss window — the 1-3 trades after a loss are where I do damage.
- Flag playbook deviations vs named setups.

Edit this often. It's your steering wheel; the profile below is the standing context.`

const PLACEHOLDER = `Write standing context the AI coach should know about you. A few examples:

- My system is a 2-ATR scalp — don't critique me for not capturing more MFE after that target.
- I trade MNQ only. Don't reference NQ, ES, or other instruments.
- I take a forced break after 2 consecutive losses by rule. Short trade counts after losses are intentional, not undertrading.
- I never use mental stops — every trade has a logged stop_price.
- My S&D entries require 2/3 orderflow signals AND a clear AOI. If you see one without OF, flag that explicitly.
- I do NOT add to losers under any circumstances.

Be specific. The more concrete the rules, the better the coach respects them.`

interface Profile {
  preferences_md: string
  focus_md?: string
  updated_at: string | null
  migration_pending?: boolean
  focus_migration_pending?: boolean
  hint?: string
}

export default function CoachingPreferencesClient() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [text, setText] = useState('')
  const [focus, setFocus] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  // Load existing profile on mount.
  useEffect(() => {
    let cancelled = false
    fetch('/api/trader-profile')
      .then(r => r.json())
      .then((data: Profile) => {
        if (cancelled) return
        setProfile(data)
        setText(data.preferences_md ?? '')
        setFocus(data.focus_md ?? '')
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'failed to load')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/trader-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences_md: text, focus_md: focus }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? `Save failed (${res.status})`)
        return
      }
      setProfile({ preferences_md: data.preferences_md, focus_md: data.focus_md, updated_at: data.updated_at })
      setDirty(false)
      setToast('Saved')
      setTimeout(() => setToast(null), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
        Loading…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {profile?.migration_pending && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-lg p-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Migration pending.</strong> Apply{' '}
            <code className="text-amber-100 font-mono text-xs">supabase/migrations/20260617_trader_profile.sql</code>{' '}
            in the Supabase dashboard to enable saving. The page works in read-only mode until then.
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {profile?.focus_migration_pending && !profile?.migration_pending && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-lg p-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Focus field migration pending.</strong> Apply{' '}
            <code className="text-amber-100 font-mono text-xs">supabase/migrations/20260620_trader_profile_focus.sql</code>{' '}
            in the Supabase dashboard to enable saving the Coaching Focus list. Standing context still saves normally.
          </div>
        </div>
      )}

      {/* Coaching Focus — short, high-priority steering list. Injected LAST in the
          coach prompt (highest-recency slot) so it gets the most attention. */}
      <div className="bg-amber-950/10 border border-amber-800/40 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Target className="w-4 h-4 text-amber-400" />
          <span className="font-medium text-white">Coaching Focus</span>
          <span className="text-xs text-amber-300/70 ml-1">— what to weight most, injected right before your question</span>
        </div>
        <textarea
          value={focus}
          onChange={e => { setFocus(e.target.value); setDirty(true) }}
          placeholder={FOCUS_PLACEHOLDER}
          spellCheck
          autoCorrect="on"
          className="w-full h-44 bg-gray-950 border border-amber-800/40 text-gray-200 rounded-lg px-3 py-2 text-sm font-mono leading-relaxed placeholder-gray-600 focus:outline-none focus:border-amber-500 resize-vertical"
        />
        <p className="text-xs text-gray-500">{focus.length.toLocaleString()} chars · keep it short — a few sharp bullets beat paragraphs here.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Brain className="w-4 h-4 text-blue-400" />
          <span className="font-medium text-white">Your standing coaching context</span>
          {profile?.updated_at && (
            <span className="text-xs text-gray-500 ml-auto">
              Last saved: {new Date(profile.updated_at).toLocaleString()}
            </span>
          )}
        </div>

        <textarea
          value={text}
          onChange={e => { setText(e.target.value); setDirty(true) }}
          placeholder={PLACEHOLDER}
          spellCheck
          autoCorrect="on"
          className="w-full h-96 bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm font-mono leading-relaxed placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-vertical"
        />

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty || profile?.migration_pending}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save preferences'}
          </button>
          {dirty && !saving && (
            <span className="text-xs text-amber-400">Unsaved changes</span>
          )}
          {toast && (
            <span className="text-xs text-green-400 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> {toast}
            </span>
          )}
          <span className="text-xs text-gray-500 ml-auto">
            {text.length.toLocaleString()} chars
          </span>
        </div>
      </div>

      <div className="bg-blue-950/20 border border-blue-900/40 rounded-lg p-4 text-xs text-blue-200/80">
        <div className="flex items-center gap-2 mb-2 text-blue-300">
          <Lightbulb className="w-4 h-4" />
          <span className="font-semibold uppercase tracking-wider text-[10px]">Tips for good preferences</span>
        </div>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Be specific.</strong> &ldquo;Don&apos;t critique my exits&rdquo; is too vague. &ldquo;My TP1 is 2 ATR — don&apos;t flag exits at TP1 as leaving MFE on the table&rdquo; is actionable.</li>
          <li><strong>Name your edge.</strong> Tell the coach what your setups need to be valid (orderflow signals, AOI quality, etc.) so it can call out violations vs respect intentional choices.</li>
          <li><strong>State your hard rules.</strong> Daily loss limit, cooldown, no-add-to-loser, position-size caps — anything you treat as non-negotiable.</li>
          <li><strong>Update over time.</strong> As your system evolves, edit this. Stale preferences will bias the coach toward old habits.</li>
        </ul>
      </div>
    </div>
  )
}
