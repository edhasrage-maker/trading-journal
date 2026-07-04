'use client'

import { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'

const field = 'w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm leading-relaxed focus:outline-none focus:border-blue-500 resize-vertical'

/** Step 5 — the AI drafts a Player Profile from every prior answer, shown
 *  editable. The user confirms (or rewrites) before it saves to trader_profile.
 *  Degrades to a blank editable box if the AI cap is hit or the call fails. */
export default function ReviewStep({ onNext, onSkipAll }: { onNext: () => void; onSkipAll: () => void }) {
  const [profile, setProfile] = useState('')
  const [focus, setFocus] = useState('')
  const [drafting, setDrafting] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const draft = async () => {
    setDrafting(true); setNote(null)
    try {
      const res = await fetch('/api/onboarding/synthesize', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.status === 429) setNote(d.error ?? 'Daily AI limit reached — you can write your profile yourself below.')
      else if (d.error) setNote(d.error)
      setProfile(d.preferences_md ?? '')
      setFocus(d.focus_md ?? '')
    } catch {
      setNote('AI draft unavailable — you can write your profile yourself below.')
    } finally { setDrafting(false) }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kick the one-time AI draft on mount
    draft()
  }, [])

  const saveAndFinish = async () => {
    setSaving(true)
    try {
      await fetch('/api/trader-profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences_md: profile, focus_md: focus }),
      })
      onNext()
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-400" /> Review your Player Profile
        </h2>
        <p className="text-sm text-gray-400 mt-1">Your coach drafted this from your answers. Edit anything, then save — it&apos;s the standing context the coach reads before every analysis.</p>
      </div>
      {note && <p className="text-sm text-amber-400">{note}</p>}

      {drafting ? (
        <div className="text-center text-gray-500 py-10"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Drafting your profile…</div>
      ) : (
        <>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Player Profile (standing context)</span>
            <textarea value={profile} onChange={e => setProfile(e.target.value)} rows={12} placeholder="Your instruments, style, playbook, rules, strengths, and leaks…" className={field} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Coaching focus (what to weight most)</span>
            <textarea value={focus} onChange={e => setFocus(e.target.value)} rows={4} placeholder="The 2–4 things to weight most right now…" className={field} />
          </label>
          <div className="flex items-center justify-between pt-1">
            <button type="button" onClick={draft} className="text-sm text-gray-500 hover:text-gray-300">↻ Re-draft</button>
            <div className="flex items-center gap-4">
              <button type="button" onClick={onSkipAll} className="text-sm text-gray-500 hover:text-gray-300">Skip</button>
              <button type="button" onClick={saveAndFinish} disabled={saving}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors inline-flex items-center gap-2">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}Save &amp; finish
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
