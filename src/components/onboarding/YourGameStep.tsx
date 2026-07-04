'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CaptureItem, type CaptureValue } from './CaptureItem'

const MISTAKES = ['Revenge trading', 'Oversizing', 'Cutting winners early', 'Chasing / FOMO', 'Moving stops', 'Overtrading', 'Impulse (no setup)']
const EMOTIONS = ['Stable', 'FOMO', 'Frustrated', 'Impatient', 'Fearful', 'Overconfident', 'Tilted']
const METRICS = ['MFE capture', 'Heat / MAE', 'Win rate', 'R / expectancy', 'Process adherence', 'Hold time', 'Consistency']
const EMPTY: CaptureValue = { status: 'unset', items: [] }
const field = 'w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500'

/** Step 4 — the reflective layer. Edge/strengths/goal are free text; leaks and
 *  emotional states run through CaptureItem (seeding mistakes/emotions tags);
 *  metrics-that-matter is a chip multi-select. Feeds the AI profile draft. */
export default function YourGameStep({ onNext, onSkipAll }: { onNext: () => void; onSkipAll: () => void }) {
  const [edge, setEdge] = useState('')
  const [strengths, setStrengths] = useState('')
  const [goal, setGoal] = useState('')
  const [metrics, setMetrics] = useState<string[]>([])
  const [mistakes, setMistakes] = useState<CaptureValue>(EMPTY)
  const [emotions, setEmotions] = useState<CaptureValue>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/onboarding').then(r => r.json()).catch(() => ({})),
      fetch('/api/trade-tags').then(r => r.json()).catch(() => []),
    ]).then(([ob, tags]) => {
      if (cancelled) return
      const yg = ob.onboarding?.your_game ?? {}
      setEdge(yg.edge ?? ''); setStrengths(yg.strengths ?? ''); setGoal(yg.goal ?? '')
      setMetrics(Array.isArray(yg.metrics) ? yg.metrics : [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byCat = (c: string) => (Array.isArray(tags) ? tags.filter((t: any) => t.category === c).map((t: any) => t.label) : [])
      const m = byCat('mistakes'); const e = byCat('emotions')
      if (m.length) setMistakes({ status: 'has', items: m })
      if (e.length) setEmotions({ status: 'has', items: e })
      setLoading(false)
    })
    return () => { cancelled = true }
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

  const save = async () => {
    setSaving(true); setError(null)
    try {
      await createTags('mistakes', mistakes)
      await createTags('emotions', emotions)
      await fetch('/api/onboarding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboarding: { your_game: { edge, strengths, goal, metrics } } }),
      })
      onNext()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally { setSaving(false) }
  }

  if (loading) return <div className="text-center text-gray-500 py-12"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white">Your game</h2>
        <p className="text-sm text-gray-400 mt-1">The honest stuff — this is what makes the coaching yours.</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <label className="block">
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

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onSkipAll} className="text-sm text-gray-500 hover:text-gray-300">Skip for now</button>
        <button type="button" onClick={save} disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors inline-flex items-center gap-2">
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}Continue
        </button>
      </div>
    </div>
  )
}
