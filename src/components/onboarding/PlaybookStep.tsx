'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CaptureItem, type CaptureValue } from './CaptureItem'

const DEFAULTS: Record<string, string[]> = {
  setups: ['Break & Retest', 'Trend Continuation', 'Reversal at Level', 'Range Fade', 'Breakout'],
  confluences: ['VWAP', 'PDH/PDL', 'IB High/Low', 'Volume Profile (POC/VAH/VAL)', 'Prior Day High/Low', 'Session Open'],
  order_flow: ['Absorption', 'Exhaustion', 'Delta Divergence', 'Break of Cluster', 'Stacked Imbalance'],
  entry_model: ['Break of Cluster/Bubble', 'Limit at AOI', 'Market on Signal', 'Stop on Break'],
}
const EMPTY: CaptureValue = { status: 'unset', items: [] }

/** Step 2 — playbook. Each category flows through the CaptureItem gate; whatever
 *  the trader keeps seeds their tag library. Order flow is a yes/no first. */
export default function PlaybookStep({ onNext, onSkipAll }: { onNext: () => void; onSkipAll: () => void }) {
  const [setups, setSetups] = useState<CaptureValue>(EMPTY)
  const [confluences, setConfluences] = useState<CaptureValue>(EMPTY)
  const [entry, setEntry] = useState<CaptureValue>(EMPTY)
  const [ofTrades, setOfTrades] = useState<boolean | null>(null)
  const [ofReads, setOfReads] = useState<CaptureValue>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/trade-tags').then(r => r.json()).then((tags: Array<{ category: string; label: string }>) => {
      if (cancelled) return
      const byCat = (cat: string) => (Array.isArray(tags) ? tags.filter(t => t.category === cat).map(t => t.label) : [])
      const pre = (items: string[]): CaptureValue => (items.length ? { status: 'has', items } : EMPTY)
      setSetups(pre(byCat('setups')))
      setConfluences(pre(byCat('confluences')))
      setEntry(pre(byCat('entry_model')))
      const of = byCat('order_flow')
      if (of.length) { setOfTrades(true); setOfReads({ status: 'has', items: of }) }
      setLoading(false)
    }).catch(() => setLoading(false))
    return () => { cancelled = true }
  }, [])

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
      await createTags('setups', setups)
      await createTags('confluences', confluences)
      await createTags('entry_model', entry)
      if (ofTrades) await createTags('order_flow', ofReads)
      await fetch('/api/onboarding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          onboarding: { playbook: { setups: setups.status, confluences: confluences.status, entry_model: entry.status, order_flow: ofTrades === false ? 'none' : ofReads.status } },
          scoring_profile: { execution: { uses_orderflow: ofTrades === true } },
        }),
      })
      onNext()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally { setSaving(false) }
  }

  if (loading) return <div className="text-center text-gray-500 py-12"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Your playbook</h2>
        <p className="text-sm text-gray-400 mt-1">What you trade and the reads behind it. Whatever you keep seeds your tag library.</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <CaptureItem label="Setups" question="Do you trade named setups?" defaults={DEFAULTS.setups} value={setups} onChange={setSetups} placeholder="e.g. IB fade" />
      <CaptureItem label="Confluences" question="Do you require confluences (levels, VWAP, profile…)?" defaults={DEFAULTS.confluences} value={confluences} onChange={setConfluences} placeholder="e.g. PDL" />

      {/* Order flow — yes/no first (not everyone trades it). */}
      <div className="border border-gray-800 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-gray-200">Order flow</span>
          {ofTrades !== null && <button type="button" onClick={() => setOfTrades(null)} className="text-xs text-gray-500 hover:text-gray-300">Change</button>}
        </div>
        {ofTrades === null && (
          <div className="space-y-3">
            <p className="text-sm text-gray-400">Do you trade order flow?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setOfTrades(true)} className="text-sm px-3 py-1.5 rounded-lg border border-blue-700 text-blue-300 hover:bg-blue-950/40">Yes</button>
              <button type="button" onClick={() => setOfTrades(false)} className="text-sm px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800">No, I don&apos;t</button>
            </div>
          </div>
        )}
        {ofTrades === false && <p className="text-sm text-gray-500">Got it — the coach won&apos;t grade you on order-flow reads.</p>}
        {ofTrades === true && (
          <CaptureItem label="Order-flow reads" question="Which order-flow reads do you use?" defaults={DEFAULTS.order_flow} value={ofReads} onChange={setOfReads} placeholder="e.g. Absorption" />
        )}
      </div>

      <CaptureItem label="Entry model" question="Do you have a defined entry trigger?" defaults={DEFAULTS.entry_model} value={entry} onChange={setEntry} placeholder="e.g. Limit at AOI" />

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
