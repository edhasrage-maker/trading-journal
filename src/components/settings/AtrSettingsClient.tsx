'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save, AlertCircle, CheckCircle2, Activity, Info } from 'lucide-react'
import {
  ATR_TIMEFRAMES, ATR_METHODS, ATR_METHOD_LABELS, DEFAULT_ATR_CONFIG, DEFAULT_GIVE_BACK_ATR,
  normalizeGiveBackAtr, type AtrConfig, type AtrMethod,
} from '@/lib/atr-config'

interface Resp extends Partial<AtrConfig> {
  give_back_atr?: number
  migration_pending?: boolean
  hint?: string
}

export default function AtrSettingsClient() {
  const [cfg, setCfg] = useState<AtrConfig>(DEFAULT_ATR_CONFIG)
  const [saved, setSaved] = useState<AtrConfig>(DEFAULT_ATR_CONFIG)
  const [giveBack, setGiveBack] = useState<number>(DEFAULT_GIVE_BACK_ATR)
  const [savedGiveBack, setSavedGiveBack] = useState<number>(DEFAULT_GIVE_BACK_ATR)
  const [migrationPending, setMigrationPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/atr-config')
      .then(r => r.json())
      .then((d: Resp) => {
        if (cancelled) return
        const next: AtrConfig = {
          timeframe: Number(d.timeframe ?? DEFAULT_ATR_CONFIG.timeframe),
          method: (d.method as AtrMethod) ?? DEFAULT_ATR_CONFIG.method,
          period: Number(d.period ?? DEFAULT_ATR_CONFIG.period),
        }
        setCfg(next); setSaved(next)
        const gb = normalizeGiveBackAtr(d.give_back_atr)
        setGiveBack(gb); setSavedGiveBack(gb)
        setMigrationPending(Boolean(d.migration_pending))
        setLoading(false)
      })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : 'failed to load'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const periodValid = Number.isFinite(cfg.period) && cfg.period >= 2 && cfg.period <= 200
  const giveBackValid = Number.isFinite(giveBack) && giveBack >= 0.25 && giveBack <= 10
  const dirty = periodValid && giveBackValid &&
    (cfg.timeframe !== saved.timeframe || cfg.method !== saved.method || cfg.period !== saved.period || giveBack !== savedGiveBack)

  const save = async () => {
    if (!periodValid || !giveBackValid) return
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/atr-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, give_back_atr: giveBack }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error ?? `Save failed (${res.status})`); if (d.migration_pending) setMigrationPending(true); return }
      const next: AtrConfig = { timeframe: Number(d.timeframe), method: d.method, period: Number(d.period) }
      setSaved(next); setCfg(next)
      const gb = normalizeGiveBackAtr(d.give_back_atr)
      setGiveBack(gb); setSavedGiveBack(gb)
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

  const summary = `${cfg.timeframe}m · ${ATR_METHOD_LABELS[cfg.method]} · period ${periodValid ? cfg.period : '—'} · give-back ${giveBackValid ? giveBack : '—'}×`

  return (
    <div className="space-y-4">
      {migrationPending && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-lg p-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div><strong>Migration pending.</strong> Add the <code className="text-amber-100 font-mono text-xs">atr_timeframe / atr_method / atr_period</code> columns on <code className="text-amber-100 font-mono text-xs">trader_profile</code> to enable saving.</div>
        </div>
      )}
      {error && (
        <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /><div>{error}</div>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <Activity className="w-4 h-4 text-blue-400" />
          <span className="font-medium text-white">ATR measurement</span>
          <span className="text-xs text-gray-500 ml-auto font-mono">{summary}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="flex flex-col gap-1.5 text-xs text-gray-400">
            Timeframe
            <select
              value={cfg.timeframe}
              onChange={e => setCfg(c => ({ ...c, timeframe: Number(e.target.value) }))}
              className="bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {ATR_TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}m</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-gray-400">
            Method
            <select
              value={cfg.method}
              onChange={e => setCfg(c => ({ ...c, method: e.target.value as AtrMethod }))}
              className="bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {ATR_METHODS.map(m => <option key={m} value={m}>{ATR_METHOD_LABELS[m]}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-gray-400">
            Period
            <input
              type="number" min={2} max={200} step={1}
              value={cfg.period}
              onChange={e => setCfg(c => ({ ...c, period: Number(e.target.value) }))}
              className="bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>
        </div>

        {!periodValid && <p className="text-xs text-red-400">Period must be between 2 and 200.</p>}

        {/* Round-trip give-back threshold — the ×ATR a trade must run in your
            favor before a close ≤ BE counts as "gave it back". Separate concept
            from the ATR measurement above (which defines the ATR itself). */}
        <div className="pt-3 border-t border-gray-800">
          <label className="flex flex-col gap-1.5 text-xs text-gray-400 max-w-xs">
            <span className="flex items-center gap-1.5">
              Give-back threshold (×ATR)
              <span
                title="A 'gave it back' trade ran at least this many ×ATR in your favor, then closed at or below breakeven. Surfaces on the EOD Entry-efficiency panel and is read by the coach. Default 1×."
                className="cursor-help text-gray-500 hover:text-gray-300"
                aria-label="What the give-back threshold does"
              >
                <Info className="w-3.5 h-3.5" />
              </span>
            </span>
            <input
              type="number" min={0.25} max={10} step={0.25}
              value={giveBack}
              onChange={e => setGiveBack(Number(e.target.value))}
              className="bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>
          {!giveBackValid && <p className="text-xs text-red-400 mt-1">Give-back threshold must be between 0.25 and 10.</p>}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty || migrationPending}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
          {dirty && !saving && <span className="text-xs text-amber-400">Unsaved changes</span>}
          {toast && <span className="text-xs text-green-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> {toast}</span>}
        </div>
      </div>

      <div className="bg-blue-950/20 border border-blue-900/40 rounded-lg p-4 text-xs text-blue-200/80 space-y-2">
        <p className="text-blue-300 font-semibold uppercase tracking-wider text-[10px]">Where it applies</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Drives the <strong>ATR@ column</strong> and the <strong>ATR-unit R fallback</strong> (used when a trade has no stop and no TP) on the <strong>EOD Recap</strong>, computed live from bars.</li>
          <li>Default <strong>1m · Wilder&apos;s · 10</strong> matches the Sierra Chart ATR-10.</li>
          <li>The <strong>give-back threshold</strong> sets how far a trade must run your way (in ×ATR) before a close ≤ breakeven counts as a &ldquo;gave it back&rdquo; on the EOD panel + coach. Default <strong>1×</strong>.</li>
          <li>Needs 1-minute bars for the day; days without bars fall back to the stored 1m Wilder-10 value.</li>
          <li className="text-blue-300/70">Rolling this out to analytics/dashboard aggregates is a follow-up (requires a per-trade recompute).</li>
        </ul>
      </div>
    </div>
  )
}
