'use client'

import { useEffect, useState } from 'react'
import { Loader2, X, Check, Plus, Sparkles } from 'lucide-react'
import { STARTER_SETUPS, STARTER_DEFAULT_RULES } from '@/lib/onboarding-starters'

const SESSIONS: Array<[string, string]> = [
  ['rth', 'RTH — regular session (06:30–13:00 PT)'],
  ['eth', 'ETH — overnight / Globex'],
  ['both', 'Both RTH + overnight'],
]

const field = 'w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500'

/** Normalize a comma-separated instrument string into de-duped upper-case chips. */
function parseInstruments(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(',')) {
    const v = part.trim().toUpperCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * The "New / still finding my style" path — ONE light screen. Captures just an
 * instrument, session, an optional free-text line, and an optional starter
 * setup, then silently drafts the Player Profile (no editable Review) and drops
 * the user straight into the app. Expectation-setting copy reframes an empty
 * profile as the start of a journey, not a failure.
 */
export default function NewTraderStep({
  onDone, onSkipAll, onBack,
}: {
  onDone: () => void
  onSkipAll: () => void
  onBack: () => void
}) {
  const [instruments, setInstruments] = useState<string[]>([])
  const [instDraft, setInstDraft] = useState('')
  const [session, setSession] = useState('')
  const [note, setNote] = useState('')
  const [starters, setStarters] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/trading-defaults').then(r => r.json()).catch(() => ({})),
      fetch('/api/onboarding').then(r => r.json()).catch(() => ({})),
    ]).then(([td, ob]) => {
      if (cancelled) return
      setInstruments(parseInstruments(td.default_instrument ?? ''))
      setSession(ob.scoring_profile?.session ?? '')
      setNote(ob.onboarding?.your_game?.edge ?? '')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const addInstrument = (raw?: string) => {
    const v = (raw ?? instDraft).trim().toUpperCase()
    if (!v) return
    if (!instruments.includes(v)) setInstruments([...instruments, v])
    if (!raw) setInstDraft('')
  }
  const removeInstrument = (v: string) => setInstruments(instruments.filter(x => x !== v))
  const toggleStarter = (key: string) => setStarters(prev => {
    const n = new Set(prev)
    if (n.has(key)) n.delete(key); else n.add(key)
    return n
  })

  const seedStarterTags = async () => {
    const chosen = STARTER_SETUPS.filter(s => starters.has(s.key))
    for (const s of chosen) {
      for (const [category, labels] of Object.entries(s.tags)) {
        for (const label of labels ?? []) {
          await fetch('/api/trade-tags', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category, label }),
          }).catch(() => {})
        }
      }
    }
    return chosen.length > 0
  }

  const save = async () => {
    setSaving(true); setError(null)
    try {
      // Fold any half-typed instrument draft into the list so it isn't lost.
      const list = instDraft.trim() ? parseInstruments([...instruments, instDraft].join(',')) : instruments
      await fetch('/api/trading-defaults', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_instrument: list.join(', ') }),
      })

      const seeded = await seedStarterTags()

      // scoring_profile: session, no order flow expected of a new trader, and —
      // if a starter was picked — the shared sane default rules to grade against.
      const scoring_profile: Record<string, unknown> = {
        session,
        execution: { uses_orderflow: false },
      }
      if (seeded) Object.assign(scoring_profile, STARTER_DEFAULT_RULES)

      await fetch('/api/onboarding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scoring_profile,
          onboarding: {
            path: 'new',
            new_starters: [...starters],
            // Store the free-text under your_game.edge so /synthesize picks it up.
            your_game: { edge: note.trim() },
          },
        }),
      })

      // Silently draft + save the Player Profile — the New path never shows the
      // editable Review step. Degrades quietly if the AI cap is hit or it fails.
      try {
        const res = await fetch('/api/onboarding/synthesize', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        if (d.preferences_md || d.focus_md) {
          await fetch('/api/trader-profile', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences_md: d.preferences_md ?? '', focus_md: d.focus_md ?? '' }),
          }).catch(() => {})
        }
      } catch { /* no profile draft — the coach still works from the structured data */ }

      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
      setSaving(false)
    }
  }

  if (loading) return <div className="text-center text-gray-500 py-12"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Let’s start light</h2>
        <p className="text-sm text-gray-400 mt-1">Just the basics. Your coach learns your style as you log trades — this only gets sharper over time.</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="block">
          <span className="text-xs text-gray-500 mb-1 block">What do you trade?</span>
          <div className={`${field} font-mono flex flex-wrap items-center gap-1.5 min-h-[38px] py-1.5`}>
            {instruments.map((inst, i) => (
              <span key={inst} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-gray-700 bg-gray-800/60 text-gray-200">
                {inst}{i === 0 && <span className="text-[9px] font-sans uppercase tracking-wider text-blue-400">primary</span>}
                <button type="button" onClick={() => removeInstrument(inst)} className="text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
              </span>
            ))}
            <input value={instDraft}
              onChange={e => setInstDraft(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addInstrument() } else if (e.key === 'Backspace' && !instDraft && instruments.length) { removeInstrument(instruments[instruments.length - 1]) } }}
              onBlur={() => addInstrument()}
              placeholder={instruments.length ? 'add another…' : 'e.g. NQ'}
              className="flex-1 min-w-[80px] bg-transparent outline-none text-sm" />
          </div>
          <span className="text-[10px] text-gray-600 mt-1 block">Press Enter or comma to add more.</span>
        </div>
        <label className="block">
          <span className="text-xs text-gray-500 mb-1 block">When do you trade?</span>
          <select value={session} onChange={e => setSession(e.target.value)} className={field}>
            <option value="">— select —</option>
            {SESSIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-xs text-gray-500 mb-1 block">Anything you’d like to tell us about your trading? <span className="text-gray-600">(optional)</span></span>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
          placeholder="Even one sentence helps — what you’re working on, what’s been hard, what you want from a coach…"
          className={`${field} leading-relaxed resize-vertical`} />
      </label>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-gray-500">Want a starting point? <span className="text-gray-600">(optional)</span></span>
          <span className="text-[10px] text-gray-600">Seeds a couple of tags &amp; sane rules — edit anytime.</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          {STARTER_SETUPS.map(s => {
            const on = starters.has(s.key)
            return (
              <button key={s.key} type="button" onClick={() => toggleStarter(s.key)}
                className={`text-left border rounded-lg p-3.5 transition-colors ${on ? 'border-blue-600 bg-blue-950/30' : 'border-gray-800 hover:border-gray-600 bg-gray-950/40'}`}>
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-medium ${on ? 'text-blue-200' : 'text-gray-200'}`}>{s.name}</span>
                  <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full border ${on ? 'border-blue-500 bg-blue-600 text-[#2A1D07]' : 'border-gray-700 text-gray-600'}`}>
                    {on ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">{s.blurb}</p>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onBack} className="text-sm text-gray-500 hover:text-gray-300">← Back</button>
        <div className="flex items-center gap-4">
          <button type="button" onClick={onSkipAll} className="text-sm text-gray-500 hover:text-gray-300">Skip for now</button>
          <button type="button" onClick={save} disabled={saving}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors inline-flex items-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}{saving ? 'Setting up…' : 'Finish setup'}
          </button>
        </div>
      </div>
    </div>
  )
}
