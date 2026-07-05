'use client'

import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'

const SESSIONS: Array<[string, string]> = [
  ['rth', 'RTH — regular session (06:30–13:00 PT)'],
  ['eth', 'ETH — overnight / Globex'],
  ['both', 'Both RTH + overnight'],
]
const TIMEZONES: Array<[string, string]> = [
  ['America/New_York', 'Eastern (New York)'],
  ['America/Chicago', 'Central (Chicago)'],
  ['America/Denver', 'Mountain (Denver)'],
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
  ['America/Phoenix', 'Arizona (no DST)'],
  ['UTC', 'UTC'],
]

/** Split a stored comma-separated instrument string into normalized chips. */
function parseInstruments(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(',')) {
    const v = part.trim().toUpperCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** Step 1 — account & markets. Writes name/instrument(s)/account/timezone to the
 *  Trading Defaults, and the traded session to the scoring profile. The first
 *  instrument chip is treated as primary (chart/coach default). */
export default function AccountStep({ onNext, onSkipAll }: { onNext: () => void; onSkipAll: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const [instruments, setInstruments] = useState<string[]>([])
  const [instDraft, setInstDraft] = useState('')
  const [accountSize, setAccountSize] = useState('')
  const [timezone, setTimezone] = useState('')
  const [session, setSession] = useState('')
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
      setDisplayName(td.display_name ?? '')
      setInstruments(parseInstruments(td.default_instrument ?? ''))
      setAccountSize(td.account_size != null ? String(td.account_size) : '')
      setTimezone(td.timezone ?? '')
      setSession(ob.scoring_profile?.session ?? '')
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

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const acc = accountSize.trim() === '' ? null : parseFloat(accountSize)
      // Fold any half-typed draft into the list so it isn't silently lost.
      const list = instDraft.trim() ? parseInstruments([...instruments, instDraft].join(',')) : instruments
      await fetch('/api/trading-defaults', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, default_instrument: list.join(', '), account_size: acc, timezone }),
      })
      await fetch('/api/onboarding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoring_profile: { session } }),
      })
      onNext()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally { setSaving(false) }
  }

  if (loading) {
    return <div className="text-center text-gray-500 py-12"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
  }

  const field = 'w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white">Account &amp; markets</h2>
        <p className="text-sm text-gray-400 mt-1">The basics your coach needs — so it speaks in your instruments, risk, and clock.</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-xs text-gray-500 mb-1 block">Display name</span>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Edison" className={field} />
        </label>
        <div className="block">
          <span className="text-xs text-gray-500 mb-1 block">Instruments you trade</span>
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
          <span className="text-[10px] text-gray-600 mt-1 block">Press Enter or comma to add. First one is your primary (chart &amp; coach default).</span>
        </div>
        <label className="block">
          <span className="text-xs text-gray-500 mb-1 block">Account size ($)</span>
          <input type="number" inputMode="decimal" min={0} value={accountSize} onChange={e => setAccountSize(e.target.value)} placeholder="e.g. 50000" className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500 mb-1 block">Timezone</span>
          <select value={timezone} onChange={e => setTimezone(e.target.value)} className={field}>
            <option value="">— select —</option>
            {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {timezone && !TIMEZONES.some(([v]) => v === timezone) && <option value={timezone}>{timezone}</option>}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500 mb-1 block">Session you trade</span>
          <select value={session} onChange={e => setSession(e.target.value)} className={field}>
            <option value="">— select —</option>
            {SESSIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
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
