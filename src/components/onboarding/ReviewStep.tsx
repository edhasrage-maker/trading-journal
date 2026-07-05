'use client'

import { useEffect, useState } from 'react'
import { Loader2, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'
import { CaptureItem, type CaptureValue } from './CaptureItem'

const MISTAKES = ['Revenge trading', 'Oversizing', 'Cutting winners early', 'Chasing / FOMO', 'Moving stops', 'Overtrading', 'Impulse (no setup)']
const EMOTIONS = ['Stable', 'FOMO', 'Frustrated', 'Impatient', 'Fearful', 'Overconfident', 'Tilted']
const METRICS = ['MFE capture', 'Heat / MAE', 'Win rate', 'R / expectancy', 'Process adherence', 'Hold time', 'Consistency']
const EMPTY: CaptureValue = { status: 'unset', items: [] }

const field = 'w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm leading-relaxed focus:outline-none focus:border-blue-500 resize-vertical'

/** Final step — the AI drafts a Player Profile from every prior answer, shown
 *  editable. The "Your game" reflection (edge / strengths / leaks / goal /
 *  metrics) is demoted to an OPTIONAL dashed card here rather than its own step;
 *  filling it and re-drafting folds it into the profile. Degrades to a blank
 *  editable box if the AI cap is hit or the call fails. */
export default function ReviewStep({ onNext, onSkipAll }: { onNext: () => void; onSkipAll: () => void }) {
  const [profile, setProfile] = useState('')
  const [focus, setFocus] = useState('')
  const [drafting, setDrafting] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // "Your game" — optional reflective layer, collapsed by default.
  const [gameOpen, setGameOpen] = useState(false)
  const [edge, setEdge] = useState('')
  const [strengths, setStrengths] = useState('')
  const [goal, setGoal] = useState('')
  const [metrics, setMetrics] = useState<string[]>([])
  const [mistakes, setMistakes] = useState<CaptureValue>(EMPTY)
  const [emotions, setEmotions] = useState<CaptureValue>(EMPTY)

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
    // Load any previously-saved "your game" answers for the optional card.
    fetch('/api/onboarding').then(r => r.json()).then(ob => {
      const yg = ob.onboarding?.your_game ?? {}
      setEdge(yg.edge ?? ''); setStrengths(yg.strengths ?? ''); setGoal(yg.goal ?? '')
      setMetrics(Array.isArray(yg.metrics) ? yg.metrics : [])
    }).catch(() => {})
    fetch('/api/trade-tags').then(r => r.json()).then(tags => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byCat = (c: string) => (Array.isArray(tags) ? tags.filter((t: any) => t.category === c).map((t: any) => t.label) : [])
      const m = byCat('mistakes'); const e = byCat('emotions')
      if (m.length) setMistakes({ status: 'has', items: m })
      if (e.length) setEmotions({ status: 'has', items: e })
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kick the one-time AI draft on mount
    draft()
  }, [])

  const toggleMetric = (mt: string) => setMetrics(prev => prev.includes(mt) ? prev.filter(x => x !== mt) : [...prev, mt])

  const createTags = async (category: string, v: CaptureValue) => {
    if (v.status === 'skipped' || v.status === 'unset') return
    for (const label of v.items) {
      await fetch('/api/trade-tags', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, label }),
      }).catch(() => {})
    }
  }

  // Persist the optional "your game" answers + seed mistake/emotion tags. Called
  // before both re-draft and finish so anything typed is folded in and stored.
  const saveGame = async () => {
    await createTags('mistakes', mistakes)
    await createTags('emotions', emotions)
    await fetch('/api/onboarding', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding: { your_game: { edge, strengths, goal, metrics } } }),
    }).catch(() => {})
  }

  const reDraft = async () => { await saveGame(); await draft() }

  const saveAndFinish = async () => {
    setSaving(true)
    try {
      await saveGame()
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

      {/* Optional reflective layer — demoted from its own step to a dashed card. */}
      <div className="border border-dashed border-gray-700 rounded-lg">
        <button type="button" onClick={() => setGameOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-3 text-left">
          {gameOpen ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
          <span className="text-sm font-medium text-gray-200">Add a bit about your game</span>
          <span className="text-xs text-gray-500">optional — the honest stuff that makes coaching yours</span>
        </button>
        {gameOpen && (
          <div className="px-4 pb-4 space-y-4 border-t border-gray-800">
            <label className="block pt-3">
              <span className="text-xs text-gray-500 mb-1 block">Your edge / style, in a sentence</span>
              <textarea value={edge} onChange={e => setEdge(e.target.value)} rows={2} placeholder="e.g. Discretionary NQ scalper fading extremes into IB levels with order-flow confirmation." className={field} />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500 mb-1 block">What you do well</span>
              <textarea value={strengths} onChange={e => setStrengths(e.target.value)} rows={2} placeholder="e.g. Patient entries at my levels; good at sitting on winners to target." className={field} />
            </label>
            <CaptureItem label="Common mistakes / leaks" question="Do you have recurring mistakes to watch for?" defaults={MISTAKES} value={mistakes} onChange={setMistakes} placeholder="e.g. Revenge trading" />
            <CaptureItem label="Emotional states to flag" question="Any emotional states you want the coach to call out?" defaults={EMOTIONS} value={emotions} onChange={setEmotions} placeholder="e.g. Tilted" />
            <label className="block">
              <span className="text-xs text-gray-500 mb-1 block">Your #1 goal right now</span>
              <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={2} placeholder="e.g. Stop giving back winners — hold to my planned target." className={field} />
            </label>
            <div>
              <span className="text-xs text-gray-500 mb-2 block">Metrics that matter most to you</span>
              <div className="flex flex-wrap gap-1.5">
                {METRICS.map(m => (
                  <button key={m} type="button" onClick={() => toggleMetric(m)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${metrics.includes(m) ? 'border-blue-600 text-blue-300 bg-blue-950/40' : 'border-gray-700 text-gray-400 hover:border-gray-500'}`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-gray-500">Re-draft below to fold these into your profile.</p>
          </div>
        )}
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
            <button type="button" onClick={reDraft} className="text-sm text-gray-500 hover:text-gray-300">↻ Re-draft</button>
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
