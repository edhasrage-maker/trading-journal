'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save, AlertCircle, CheckCircle2, DollarSign } from 'lucide-react'

interface SettingsResp {
  commission_per_side?: number
  updated_at?: string | null
  migration_pending?: boolean
  hint?: string
}

export default function CommissionSettingsClient() {
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [migrationPending, setMigrationPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/user-settings')
      .then(r => r.json())
      .then((data: SettingsResp) => {
        if (cancelled) return
        const v = Number(data.commission_per_side ?? 0)
        setSavedValue(v)
        setValue(v ? String(v) : '')
        setUpdatedAt(data.updated_at ?? null)
        setMigrationPending(Boolean(data.migration_pending))
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'failed to load')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const parsed = value.trim() === '' ? 0 : parseFloat(value)
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000
  const dirty = valid && parsed !== savedValue

  const save = async () => {
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/user-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commission_per_side: parsed }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? `Save failed (${res.status})`)
        if (data.migration_pending) setMigrationPending(true)
        return
      }
      setSavedValue(Number(data.commission_per_side ?? parsed))
      setUpdatedAt(data.updated_at ?? null)
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
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    )
  }

  const roundTurn = valid ? parsed * 2 : 0

  return (
    <div className="space-y-4">
      {migrationPending && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-lg p-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Migration pending.</strong> Apply{' '}
            <code className="text-amber-100 font-mono text-xs">supabase/migrations/20260702_commission_per_side.sql</code>{' '}
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
          <DollarSign className="w-4 h-4 text-emerald-400" />
          <span className="font-medium text-white">Commission per contract, per side</span>
          {updatedAt && (
            <span className="text-xs text-gray-500 ml-auto">Last saved: {new Date(updatedAt).toLocaleString()}</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={1000}
              step="0.01"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="0.00"
              className="w-40 bg-gray-950 border border-gray-700 text-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          <span className="text-sm text-gray-400">
            per side {valid && parsed > 0 && (
              <>· <span className="text-gray-300">${roundTurn.toFixed(2)} round-turn</span> per contract</>
            )}
          </span>
        </div>

        {!valid && value.trim() !== '' && (
          <p className="text-xs text-red-400">Enter a number between 0 and 1000.</p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty || migrationPending}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
          {dirty && !saving && <span className="text-xs text-amber-400">Unsaved changes</span>}
          {toast && (
            <span className="text-xs text-green-400 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> {toast}
            </span>
          )}
        </div>
      </div>

      <div className="bg-blue-950/20 border border-blue-900/40 rounded-lg p-4 text-xs text-blue-200/80 space-y-2">
        <p className="text-blue-300 font-semibold uppercase tracking-wider text-[10px]">How it&apos;s applied</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Applied <strong>at import</strong> to logs with <strong>no commission column</strong> (Sierra Chart exports gross P&amp;L). Each trade is charged <code className="font-mono">rate × contracts × 2</code> (a round-turn).</li>
          <li>Sources that already carry commission are <strong>left as-is</strong>: NinjaTrader (per-fill commission) and Tradezella (Net P&amp;L) import net already.</li>
          <li>Changing this affects <strong>future imports</strong>. Already-imported trades keep their stored P&amp;L — re-import a fresh export to apply a new rate.</li>
          <li>Set to <strong>0</strong> to leave P&amp;L gross.</li>
        </ul>
      </div>
    </div>
  )
}
