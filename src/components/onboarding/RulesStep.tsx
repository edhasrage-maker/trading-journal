'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

const field = 'bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-blue-500'

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="flex items-center gap-2 text-left">
      <span className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 shrink-0 ${on ? 'bg-blue-600' : 'bg-gray-700'}`}>
        <span className={`w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
      <span>
        <span className="text-sm text-gray-200">{label}</span>
        {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
      </span>
    </button>
  )
}

function RailRow({ label, unit, v, set }: { label: string; unit: string; v: { on: boolean; value: string }; set: (x: { on: boolean; value: string }) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Toggle on={v.on} onChange={on => set({ ...v, on })} label={label} />
      {v.on && (
        <div className="flex items-center gap-1.5 shrink-0">
          <input value={v.value} onChange={e => set({ ...v, value: e.target.value })} placeholder="—" inputMode="decimal" className={`${field} w-20 text-right`} />
          {unit && <span className="text-xs text-gray-500 w-16">{unit}</span>}
        </div>
      )}
    </div>
  )
}

/** Step 3 — risk & rules. Writes the per-user scoring_profile the Coach Score
 *  grades against. Each rule is opt-in (toggle) so nothing is assumed. */
export default function RulesStep({ onNext, onSkipAll }: { onNext: () => void; onSkipAll: () => void }) {
  const [risk, setRisk] = useState({ on: false, mode: 'R', value: '' })
  const [stop, setStop] = useState({ on: false, mode: 'atr', value: '' })
  const [tp, setTp] = useState({ on: false, text: '' })
  const [dll, setDll] = useState({ on: false, value: '' })
  const [maxSize, setMaxSize] = useState({ on: false, value: '' })
  const [maxTrades, setMaxTrades] = useState({ on: false, value: '' })
  const [cooldown, setCooldown] = useState({ on: false, value: '' })
  const [noAdd, setNoAdd] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/onboarding').then(r => r.json()).then(d => {
      if (cancelled) return
      const sp = d.scoring_profile ?? {}
      if (sp.risk_per_trade) setRisk({ on: true, mode: sp.risk_per_trade.mode ?? 'R', value: String(sp.risk_per_trade.value ?? '') })
      if (sp.stop) setStop({ on: true, mode: sp.stop.mode ?? 'atr', value: String(sp.stop.value ?? '') })
      if (sp.tp) setTp({ on: true, text: String(sp.tp) })
      const rails = sp.rails ?? {}
      if (rails.daily_loss_limit != null) setDll({ on: true, value: String(rails.daily_loss_limit) })
      if (rails.max_size != null) setMaxSize({ on: true, value: String(rails.max_size) })
      if (rails.max_trades != null) setMaxTrades({ on: true, value: String(rails.max_trades) })
      if (rails.cooldown_min != null) setCooldown({ on: true, value: String(rails.cooldown_min) })
      if (rails.no_add_to_loser) setNoAdd(true)
      setLoading(false)
    }).catch(() => setLoading(false))
    return () => { cancelled = true }
  }, [])

  const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null }

  const useDefaults = () => {
    setRisk({ on: true, mode: 'R', value: '1' })
    setStop({ on: true, mode: 'atr', value: '1' })
    setTp({ on: true, text: '2R (scaling allowed)' })
    setMaxTrades({ on: true, value: '7' }); setCooldown({ on: true, value: '2' }); setNoAdd(true)
  }

  const save = async () => {
    setSaving(true); setError(null)
    try {
      await fetch('/api/onboarding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scoring_profile: {
            risk_per_trade: risk.on ? { mode: risk.mode, value: num(risk.value) } : null,
            stop: stop.on ? { mode: stop.mode, value: num(stop.value) } : null,
            tp: tp.on ? tp.text : null,
            rails: {
              daily_loss_limit: dll.on ? num(dll.value) : null,
              max_size: maxSize.on ? num(maxSize.value) : null,
              max_trades: maxTrades.on ? num(maxTrades.value) : null,
              cooldown_min: cooldown.on ? num(cooldown.value) : null,
              no_add_to_loser: noAdd,
            },
          },
          onboarding: { rules_set: true },
        }),
      })
      onNext()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally { setSaving(false) }
  }

  if (loading) return <div className="text-center text-gray-500 py-12"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Risk &amp; rules</h2>
          <p className="text-sm text-gray-400 mt-1">Your non-negotiables — these become your per-user Coach Score. Turn on only the ones you actually follow.</p>
        </div>
        <button type="button" onClick={useDefaults} className="text-xs text-blue-400 hover:underline whitespace-nowrap shrink-0 mt-1">Use recommended</button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="space-y-3">
        <div className="border border-gray-800 rounded-lg p-4 space-y-3">
          <Toggle on={risk.on} onChange={v => setRisk({ ...risk, on: v })} label="Risk per trade" />
          {risk.on && (
            <div className="flex gap-2 items-center">
              <input value={risk.value} onChange={e => setRisk({ ...risk, value: e.target.value })} placeholder="e.g. 1" inputMode="decimal" className={`${field} w-24`} />
              <select value={risk.mode} onChange={e => setRisk({ ...risk, mode: e.target.value })} className={field}>
                <option value="R">R (risk units)</option><option value="$">$</option><option value="%">% of account</option>
              </select>
            </div>
          )}
        </div>
        <div className="border border-gray-800 rounded-lg p-4 space-y-3">
          <Toggle on={stop.on} onChange={v => setStop({ ...stop, on: v })} label="Stop sizing" />
          {stop.on && (
            <div className="flex gap-2 items-center">
              <input value={stop.value} onChange={e => setStop({ ...stop, value: e.target.value })} placeholder="e.g. 1" inputMode="decimal" className={`${field} w-24`} />
              <select value={stop.mode} onChange={e => setStop({ ...stop, mode: e.target.value })} className={field}>
                <option value="atr">× ATR</option><option value="pts">points</option>
              </select>
            </div>
          )}
        </div>
        <div className="border border-gray-800 rounded-lg p-4 space-y-3">
          <Toggle on={tp.on} onChange={v => setTp({ ...tp, on: v })} label="Take-profit target" />
          {tp.on && <input value={tp.text} onChange={e => setTp({ ...tp, text: e.target.value })} placeholder="e.g. 2R, or scale 1/2 at 2R" className={`${field} w-full`} />}
        </div>

        <p className="text-[10px] uppercase tracking-wider text-gray-600 pt-1">Safety rails (Coach Score)</p>
        <div className="border border-gray-800 rounded-lg p-4 space-y-4">
          <RailRow label="Daily loss limit" unit="$" v={dll} set={setDll} />
          <RailRow label="Max position size" unit="contracts" v={maxSize} set={setMaxSize} />
          <RailRow label="Max trades per day" unit="" v={maxTrades} set={setMaxTrades} />
          <RailRow label="Cooldown after a loss" unit="min" v={cooldown} set={setCooldown} />
          <Toggle on={noAdd} onChange={setNoAdd} label="Never add to a loser" hint="Adding size to a losing position is a rule breach." />
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
