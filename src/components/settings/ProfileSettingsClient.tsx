'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save, AlertCircle, CheckCircle2, User } from 'lucide-react'

const TIMEZONES: Array<[string, string]> = [
  ['America/New_York', 'Eastern (New York)'],
  ['America/Chicago', 'Central (Chicago)'],
  ['America/Denver', 'Mountain (Denver)'],
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
  ['America/Phoenix', 'Arizona (no DST)'],
  ['UTC', 'UTC'],
]

interface Resp {
  display_name?: string
  default_instrument?: string
  account_size?: number | null
  timezone?: string
  updated_at?: string | null
  migration_pending?: boolean
}

export default function ProfileSettingsClient() {
  const [displayName, setDisplayName] = useState('')
  const [instrument, setInstrument] = useState('')
  const [accountSize, setAccountSize] = useState('')
  const [tz, setTz] = useState('')
  const [saved, setSaved] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [migrationPending, setMigrationPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/trading-defaults')
      .then(r => r.json())
      .then((d: Resp) => {
        if (cancelled) return
        setDisplayName(d.display_name ?? '')
        setInstrument(d.default_instrument ?? '')
        setAccountSize(d.account_size != null ? String(d.account_size) : '')
        setTz(d.timezone ?? '')
        setSaved(d)
        setMigrationPending(Boolean(d.migration_pending))
        setLoading(false)
      })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : 'failed to load'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const accEmpty = accountSize.trim() === ''
  const accNum = accEmpty ? null : parseFloat(accountSize)
  const accValid = accEmpty || (accNum != null && Number.isFinite(accNum) && accNum >= 0)
  const dirty = !saved
    || displayName !== (saved.display_name ?? '')
    || instrument !== (saved.default_instrument ?? '')
    || (accNum ?? null) !== (saved.account_size ?? null)
    || tz !== (saved.timezone ?? '')

  const save = async () => {
    if (!accValid) return
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/trading-defaults', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, default_instrument: instrument, account_size: accNum, timezone: tz }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? `Save failed (${res.status})`); if (data.migration_pending) setMigrationPending(true); return }
      setSaved(data)
      setToast('Saved'); setTimeout(() => setToast(null), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error')
    } finally { setSaving(false) }
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {migrationPending && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-lg p-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Migration pending.</strong> Apply{' '}
            <code className="text-amber-100 font-mono text-xs">supabase/migrations/20260703_trading_defaults.sql</code>{' '}
            in the Supabase dashboard to enable saving.
          </div>
        </div>
      )}
      {error && (
        <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <User className="w-4 h-4 text-blue-400" />
          <span className="font-medium text-white">Trading defaults</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Display name</span>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Edhasrage"
              className="w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Default instrument</span>
            <input value={instrument} onChange={e => setInstrument(e.target.value.toUpperCase())} placeholder="e.g. NQ"
              className="w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Account size ($)</span>
            <input type="number" inputMode="decimal" min={0} value={accountSize} onChange={e => setAccountSize(e.target.value)} placeholder="e.g. 50000"
              className="w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Timezone</span>
            <select value={tz} onChange={e => setTz(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
              <option value="">— select —</option>
              {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              {tz && !TIMEZONES.some(([v]) => v === tz) && <option value={tz}>{tz}</option>}
            </select>
          </label>
        </div>
        {!accValid && <p className="text-xs text-red-400">Account size must be a non-negative number.</p>}

        <div className="flex items-center gap-3">
          <button type="button" onClick={save} disabled={saving || !dirty || !accValid || migrationPending}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
          {dirty && !saving && <span className="text-xs text-amber-400">Unsaved changes</span>}
          {toast && <span className="text-xs text-green-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> {toast}</span>}
        </div>
      </div>
    </div>
  )
}
