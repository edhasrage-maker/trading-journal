'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Save, Loader2, AlertTriangle, Info, Activity, Clock, Check } from 'lucide-react'
import {
  VERDICT_LABELS,
  VERDICT_DISPLAY,
  VERDICT_EMOJI,
  VERDICT_TONE,
  type LookupOutcome,
  type MatchResult,
  type BucketAssignment,
} from '@/lib/condition-lookup'
import type { ConditionMetric, ConditionVerdict, DailyPrep } from '@/lib/supabase/types'

/**
 * Morning prep condition filter — input 5 metrics, get a verdict, save the snapshot.
 */

const METRICS: Array<{
  metric: ConditionMetric
  field: 'rvol' | 'dr_adr' | 'ib' | 'atr_730' | 'atr_entry'
  label: string
  placeholder: string
  hint: string
}> = [
  { metric: 'RVOL', field: 'rvol', label: 'RVOL @ 7:30 PT', placeholder: '1.05', hint: 'Today\'s 6:30-7:30 volume / 10d avg of same window' },
  { metric: 'DR_ADR', field: 'dr_adr', label: 'DR vs ADR @ 7:30 PT', placeholder: '0.60', hint: '(High-Low since 6:30) / 10d avg cash session range' },
  { metric: 'IB', field: 'ib', label: 'IB vs 10d Avg', placeholder: '0.93', hint: '(IBH-IBL) / 10d avg IB range; IB = 6:30-7:30 PT' },
  { metric: 'ATR_730', field: 'atr_730', label: 'ATR-10 (1m) @ 7:30', placeholder: '18.0', hint: '1-min ATR-10 Wilder, read at 7:30 PT' },
  // ATR_entry retired: the live per-trade ATR-10 (added in a9f6161) renders
  // the manual-entry field obsolete. Kept the lookup-side bucket inert by
  // dropping the metric from this list — outcome.buckets no longer includes
  // it, so the pill row doesn't render the empty ATR_ENTRY chip.
]

// The bottom pill row + the bucket lookup still need values for these four
// metrics. The TOP-row INPUT grid only renders DR_ADR explicitly — the other
// three (RVOL, IB, ATR_730) auto-fill from Market Context above, which the
// effectiveInputs fallback below funnels into the lookup. So the user only
// types DR_ADR here; the rest flow automatically.
const VISIBLE_INPUTS: ReadonlyArray<typeof METRICS[number]['field']> = ['dr_adr']

interface VintageInfo {
  refreshed_at: string | null
  lookup_row_count: number
  threshold_count: number
}

interface LookupResponse extends LookupOutcome {
  vintage: VintageInfo
}

interface InputState {
  rvol: string
  dr_adr: string
  ib: string
  atr_730: string
  atr_entry: string
}

interface MarketContextPrefill {
  rvol?: number | null
  ib_vs_10d_avg?: number | null
  atr_1m?: number | null
  /** Server-computed DR/ADR from 1-min bars in the 6:30-7:30 PT window.
   *  When present, fills the dr_adr lookup without the user typing. */
  dr_adr?: number | null
}

interface Props {
  date: string
  /** Optional values from the Market Context form on the same page.
   *  Three fields overlap with this panel and auto-fill on mount / when
   *  Market Context changes (only if the panel field is still empty). */
  marketContext?: MarketContextPrefill
}

const EMPTY: InputState = { rvol: '', dr_adr: '', ib: '', atr_730: '', atr_entry: '' }

// Set of fields that are auto-fillable from Market Context (used for visual hint)
const PREFILL_FIELDS: Array<keyof InputState> = ['rvol', 'ib', 'atr_730', 'dr_adr']

export default function ConditionFilterPanel({ date, marketContext }: Props) {
  const [inputs, setInputs] = useState<InputState>(EMPTY)
  const [outcome, setOutcome] = useState<LookupResponse | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const [migrationNeeded, setMigrationNeeded] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // "Effective" inputs — the user-typed value if present, otherwise the
  // Market Context value for the three overlapping fields. Computed at render
  // time so updates to Market Context flow through automatically; user-typed
  // values always win.
  const fromContext = (raw: number | null | undefined): string =>
    raw != null && Number.isFinite(raw) ? String(raw) : ''
  const effectiveInputs: InputState = {
    rvol: inputs.rvol || fromContext(marketContext?.rvol),
    dr_adr: inputs.dr_adr || fromContext(marketContext?.dr_adr),
    ib: inputs.ib || fromContext(marketContext?.ib_vs_10d_avg),
    atr_730: inputs.atr_730 || fromContext(marketContext?.atr_1m),
    atr_entry: inputs.atr_entry,
  }
  const isAutoFilled = (field: keyof InputState): boolean =>
    PREFILL_FIELDS.includes(field) && inputs[field] === '' && effectiveInputs[field] !== ''

  // ── Load existing prep + run initial lookup on mount ──────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/daily-prep/${date}`)
        if (!res.ok) return
        const data = await res.json() as { prep: DailyPrep | null; migrationNeeded?: boolean }
        if (cancelled) return
        if (data.migrationNeeded) setMigrationNeeded(true)
        if (!data.prep) return
        const p = data.prep
        const next: InputState = {
          rvol: p.rvol != null ? String(p.rvol) : '',
          dr_adr: p.dr_adr != null ? String(p.dr_adr) : '',
          ib: p.ib != null ? String(p.ib) : '',
          atr_730: p.atr_730 != null ? String(p.atr_730) : '',
          atr_entry: p.atr_entry != null ? String(p.atr_entry) : '',
        }
        setInputs(next)
        setNotes(p.notes ?? '')
        setLastSavedAt(new Date(p.updated_at).getTime())
        setSaveStatus('saved')
      } catch {
        // silent
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  // ── Debounced lookup on input change ──────────────────────────────────────
  const runLookup = useCallback(async (state: InputState) => {
    const parsed = {
      rvol: parseFloat(state.rvol),
      dr_adr: parseFloat(state.dr_adr),
      ib: parseFloat(state.ib),
      atr_730: parseFloat(state.atr_730),
      atr_entry: parseFloat(state.atr_entry),
    }
    const anyValid = Object.values(parsed).some(v => Number.isFinite(v))
    if (!anyValid) {
      setOutcome(null)
      setError(null)
      return
    }
    setLookingUp(true)
    setError(null)
    try {
      const body = {
        rvol: Number.isFinite(parsed.rvol) ? parsed.rvol : null,
        dr_adr: Number.isFinite(parsed.dr_adr) ? parsed.dr_adr : null,
        ib: Number.isFinite(parsed.ib) ? parsed.ib : null,
        atr_730: Number.isFinite(parsed.atr_730) ? parsed.atr_730 : null,
        atr_entry: Number.isFinite(parsed.atr_entry) ? parsed.atr_entry : null,
      }
      const res = await fetch('/api/condition-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Lookup failed')
        setOutcome(null)
        return
      }
      setOutcome(data as LookupResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup error')
    } finally {
      setLookingUp(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const snapshot = effectiveInputs
    debounceRef.current = setTimeout(() => { void runLookup(snapshot) }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // Dep array intentionally tracks the merged values so lookup re-fires when
    // either user input or Market Context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveInputs.rvol, effectiveInputs.dr_adr, effectiveInputs.ib, effectiveInputs.atr_730, effectiveInputs.atr_entry, runLookup])

  // ── Save snapshot ─────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true)
    setSaveStatus('idle')
    try {
      const parse = (s: string) => {
        const n = parseFloat(s)
        return Number.isFinite(n) ? n : null
      }
      const body = {
        rvol: parse(effectiveInputs.rvol),
        dr_adr: parse(effectiveInputs.dr_adr),
        ib: parse(effectiveInputs.ib),
        atr_730: parse(effectiveInputs.atr_730),
        atr_entry: parse(effectiveInputs.atr_entry),
        matched_median_condition_id: outcome?.best_median?.row.condition_id ?? null,
        matched_tertile_condition_id: outcome?.best_tertile?.row.condition_id ?? null,
        consolidated_verdict: outcome?.consolidated.verdict ?? null,
        conflict_flag: outcome?.conflict ?? false,
        notes: notes || null,
      }
      const res = await fetch(`/api/daily-prep/${date}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setSaveStatus('error')
        return
      }
      setSaveStatus('saved')
      setLastSavedAt(Date.now())
    } catch {
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  const v = outcome?.consolidated.verdict ?? null
  const vintage = outcome?.vintage
  const vintageAge = vintage?.refreshed_at
    // eslint-disable-next-line react-hooks/purity
    ? Math.floor((Date.now() - new Date(vintage.refreshed_at).getTime()) / (1000 * 60 * 60 * 24))
    : null
  const vintageStale = vintageAge != null && vintageAge > 60

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-white">Morning Conditions</h2>
          <button
            onClick={() => setShowInfo(true)}
            className="text-gray-500 hover:text-blue-400 transition-colors"
            title="How this works"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {vintage?.refreshed_at && (
            <span
              className={`flex items-center gap-1 ${vintageStale ? 'text-yellow-400' : 'text-gray-500'}`}
              title={vintage.refreshed_at}
            >
              <Clock className="w-3 h-3" />
              {vintageAge === 0 ? 'today' : `${vintageAge}d old`}
              {vintageStale && ' · stale'}
            </span>
          )}
          {lastSavedAt && saveStatus === 'saved' && (
            <span className="flex items-center gap-1 text-gray-500" title={new Date(lastSavedAt).toLocaleString()}>
              <Check className="w-3 h-3 text-green-500" />
              Saved {formatDistanceToNowStrict(new Date(lastSavedAt))} ago
            </span>
          )}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Migration warning */}
        {migrationNeeded && (
          <div className="bg-yellow-950/30 border border-yellow-800/50 rounded-lg px-3 py-2 flex items-start gap-2 text-xs text-yellow-200">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-yellow-400" />
            <div>
              <div className="font-semibold text-yellow-300 mb-0.5">Database migration not yet run</div>
              The <code className="bg-yellow-950/60 px-1 rounded">daily_prep</code>, <code className="bg-yellow-950/60 px-1 rounded">condition_thresholds</code>,
              and <code className="bg-yellow-950/60 px-1 rounded">condition_lookup</code> tables don&apos;t exist yet.
              Open Supabase Dashboard → SQL Editor and run the Phase 6 migration block to enable the condition filter.
              Inputs below will save once you do.
            </div>
          </div>
        )}

        {/* Input grid — only DR_ADR is exposed here. RVOL/IB/ATR_730 auto-fill
            from Market Context above and flow through `effectiveInputs` to the
            lookup; the bucket pills below display their results. Showing the
            inputs as well was just duplicate UI for the user to maintain. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-sm">
          {METRICS.filter(m => VISIBLE_INPUTS.includes(m.field)).map(m => {
            const isPrefillField = PREFILL_FIELDS.includes(m.field)
            const auto = isAutoFilled(m.field)
            return (
              <div key={m.field}>
                <label className="block text-xs font-medium text-gray-400 mb-1 flex items-center gap-1" title={m.hint}>
                  {m.label}
                  {auto && (
                    <span
                      className="text-[9px] bg-blue-900/40 border border-blue-800 text-blue-300 px-1 rounded normal-case"
                      title="Auto-filled from Market Context below. Type to override."
                    >
                      ↳ auto
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  placeholder={isPrefillField ? `${m.placeholder} · auto-fills from Market Context` : m.placeholder}
                  value={effectiveInputs[m.field]}
                  onChange={e => setInputs(s => ({ ...s, [m.field]: e.target.value }))}
                  className={`w-full bg-gray-950 border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-blue-500 font-mono ${
                    auto ? 'border-blue-900/60' : 'border-gray-700'
                  }`}
                />
              </div>
            )
          })}
        </div>

        {/* Bucket readout */}
        {outcome && (
          <BucketReadout buckets={outcome.buckets} />
        )}

        {/* Errors */}
        {error && (
          <div className="bg-red-950/40 border border-red-900 text-red-300 text-xs rounded-lg px-3 py-2 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Lookup loading */}
        {lookingUp && (
          <div className="text-xs text-gray-500 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> looking up…
          </div>
        )}

        {/* Consolidated verdict */}
        {v && outcome && (
          <ConsolidatedVerdict verdict={v} outcome={outcome} />
        )}

        {/* Conflict warning */}
        {outcome?.conflict && outcome.conflict_reason && (
          <div className="bg-orange-950/40 border border-orange-800 rounded-lg px-3 py-2 flex items-start gap-2 text-xs text-orange-200">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-orange-400" />
            <div>
              <div className="font-semibold text-orange-300 mb-0.5">Conflict</div>
              {outcome.conflict_reason}
            </div>
          </div>
        )}

        {/* Match details — side by side */}
        {outcome && (outcome.best_median || outcome.best_tertile) && (
          <div className="grid md:grid-cols-2 gap-3">
            <MatchCard title="Median view" match={outcome.best_median} picked={outcome.consolidated.pick === 'median'} />
            <MatchCard title="Tertile view" match={outcome.best_tertile} picked={outcome.consolidated.pick === 'tertile'} />
          </div>
        )}

        {/* Notes + Save */}
        <div className="space-y-2 pt-2 border-t border-gray-800">
          <label className="block text-xs text-gray-500">Notes (optional)</label>
          <textarea
            rows={2}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="What you're watching, plan deviations, etc."
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-blue-500 resize-none"
          />
          <div className="flex items-center justify-end gap-3">
            {saveStatus === 'error' && (
              <span className="text-xs text-red-400">Save failed</span>
            )}
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save snapshot'}
            </button>
          </div>
        </div>
      </div>

      {/* How this works modal */}
      {showInfo && <HowThisWorksModal onClose={() => setShowInfo(false)} vintage={vintage} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function BucketReadout({ buckets }: { buckets: BucketAssignment[] }) {
  // ATR_entry bucket is no longer surfaced — the live per-trade ATR-10 (a9f6161)
  // replaced the manual-entry input it depended on. Filter it out here rather
  // than at the API so historical persistence isn't disturbed.
  const visible = buckets.filter(b => b.metric !== 'ATR_entry')
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      {visible.map(b => (
        <div key={b.metric} className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{b.metric}</div>
          <div className="font-mono text-sm text-white">{b.value ?? <span className="text-gray-700">—</span>}</div>
          <div className="flex gap-1.5 mt-1 text-[10px] font-mono">
            <span className={`px-1.5 py-0.5 rounded ${bucketTone(b.median_bucket)}`}>
              med: {b.median_bucket ?? '—'}
            </span>
            <span className={`px-1.5 py-0.5 rounded ${tertileTone(b.tertile_bucket)}`}>
              ter: {b.tertile_bucket ?? '—'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ConsolidatedVerdict({ verdict, outcome }: { verdict: ConditionVerdict; outcome: LookupOutcome }) {
  const tone = VERDICT_TONE[verdict]
  const bg = tone === 'good'
    ? 'bg-green-950/40 border-green-800'
    : tone === 'bad'
      ? 'bg-red-950/40 border-red-800'
      : tone === 'neutral'
        ? 'bg-yellow-950/40 border-yellow-800'
        : 'bg-gray-950 border-gray-700'
  const verdictColor = tone === 'good'
    ? 'text-green-300'
    : tone === 'bad'
      ? 'text-red-300'
      : tone === 'neutral'
        ? 'text-yellow-300'
        : 'text-gray-300'
  return (
    <div className={`border rounded-xl px-5 py-4 ${bg}`}>
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl">{VERDICT_EMOJI[verdict]}</span>
          <div>
            <div className={`text-2xl font-bold ${verdictColor}`}>{VERDICT_LABELS[verdict]}</div>
            <div className="text-xs text-gray-400 mt-0.5" title={`Internal code: ${verdict}`}>{VERDICT_DISPLAY[verdict]}</div>
          </div>
        </div>
        <div className="text-right text-xs text-gray-500 font-mono">
          {outcome.consolidated.explanation}
        </div>
      </div>
    </div>
  )
}

function MatchCard({ title, match, picked }: { title: string; match: MatchResult | null; picked: boolean }) {
  if (!match) {
    return (
      <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
        <div className="text-xs text-gray-500 mb-1">{title}</div>
        <div className="text-sm text-gray-600 italic">No match</div>
      </div>
    )
  }
  const r = match.row
  const tone = VERDICT_TONE[r.verdict]
  const verdictColor = tone === 'good'
    ? 'text-green-400'
    : tone === 'bad'
      ? 'text-red-400'
      : tone === 'neutral'
        ? 'text-yellow-400'
        : 'text-gray-400'

  return (
    <div className={`bg-gray-950 border rounded-lg p-3 ${picked ? 'border-blue-700' : 'border-gray-800'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-500">{title} {picked && <span className="text-blue-400 ml-1">·  picked</span>}</div>
        <div className="text-[10px] text-gray-600 font-mono">spec {r.specificity}</div>
      </div>
      <div className={`text-sm font-semibold ${verdictColor}`} title={`Internal code: ${r.verdict}`}>
        {VERDICT_EMOJI[r.verdict]} {VERDICT_DISPLAY[r.verdict]}
      </div>
      <div className="text-[10px] text-gray-600 font-mono mb-2 truncate" title={r.condition_id}>
        {r.condition_id}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono">
        <dt className="text-gray-500">Trades</dt>
        <dd className="text-right text-gray-200">{r.n_trades ?? '—'}</dd>
        <dt className="text-gray-500">Sessions</dt>
        <dd className="text-right text-gray-200">{r.n_sessions ?? '—'}</dd>
        <dt className="text-gray-500">Trade WR</dt>
        <dd className="text-right text-gray-200">
          {r.trade_wr != null ? `${(r.trade_wr * 100).toFixed(0)}%` : '—'}
          {r.trade_wr_ci_lo != null && r.trade_wr_ci_hi != null && (
            <span className="text-gray-600"> [{(r.trade_wr_ci_lo * 100).toFixed(0)}-{(r.trade_wr_ci_hi * 100).toFixed(0)}%]</span>
          )}
        </dd>
        <dt className="text-gray-500">EV/trade</dt>
        <dd className={`text-right font-bold ${(r.ev_per_trade ?? 0) > 0 ? 'text-green-400' : (r.ev_per_trade ?? 0) < 0 ? 'text-red-400' : 'text-gray-400'}`}>
          {r.ev_per_trade != null ? `${r.ev_per_trade >= 0 ? '+' : ''}$${r.ev_per_trade.toFixed(2)}` : '—'}
          {r.ev_ci_lo != null && r.ev_ci_hi != null && (
            <div className="text-gray-600 font-normal">[{r.ev_ci_lo.toFixed(0)} to {r.ev_ci_hi.toFixed(0)}]</div>
          )}
        </dd>
        <dt className="text-gray-500">Profit factor</dt>
        <dd className="text-right text-gray-200">{r.profit_factor != null ? r.profit_factor.toFixed(2) : '—'}</dd>
        <dt className="text-gray-500">Total PnL</dt>
        <dd className={`text-right ${(r.total_pnl ?? 0) > 0 ? 'text-green-400' : (r.total_pnl ?? 0) < 0 ? 'text-red-400' : 'text-gray-400'}`}>
          {r.total_pnl != null ? `${r.total_pnl >= 0 ? '+' : ''}$${r.total_pnl.toFixed(0)}` : '—'}
        </dd>
      </dl>
    </div>
  )
}

function HowThisWorksModal({ onClose, vintage }: { onClose: () => void; vintage?: VintageInfo }) {
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div onClick={e => e.stopPropagation()} className="bg-gray-900 border border-gray-700 rounded-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">How the condition filter works</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white">✕</button>
        </div>
        <div className="text-sm text-gray-300 space-y-3">
          <p>Input today&apos;s 5 market-state metrics, computed at 7:30 AM PT (end of NY Initial Balance). The lookup table tells you whether your historical edge in similar market conditions is positive, negative, or noise.</p>

          <div>
            <div className="font-semibold text-white text-sm mb-1">Grades</div>
            <ul className="space-y-1 text-xs">
              <li><span className="text-green-400">🟢 Grade A</span> — Trade normally (n≥100, EV CI excludes zero)</li>
              <li><span className="text-green-400">🟢 Grade B</span> — Likely edge (n≥50, EV CI excludes zero)</li>
              <li><span className="text-yellow-400">🟡 Grade C</span> — n≥50, slight positive lean but CI includes zero → no statistical signal</li>
              <li><span className="text-yellow-400">🟡 Grade D</span> — n≥50, slight negative lean but CI includes zero → no statistical signal</li>
              <li><span className="text-red-400">🔴 Grade F</span> — Likely losing (n≥50, EV&lt;0, lower CI &lt; -$10) → reduce size or sit out</li>
              <li><span className="text-gray-400">⚪ Ungraded</span> — n&lt;50 historical matches</li>
            </ul>
          </div>

          <div>
            <div className="font-semibold text-white text-sm mb-1">Caveats</div>
            <ul className="space-y-1.5 text-xs list-disc list-inside text-gray-400">
              <li>All claims are from MNQ trading (2025-06 through 2026-03, n=828 trades with market data overlay). A different instrument or regime may behave differently.</li>
              <li>Grade C and Grade D mean &quot;the sample says nothing definitive.&quot; Don&apos;t read Grade C as bullish or Grade D as bearish — both mean the CI includes zero, just with a slight positive or negative lean respectively.</li>
              <li>The lookup uses only market-state metrics. It does NOT consider your setup tags, orderflow tags, or psychological state — those sit on top, not in place of.</li>
              <li>The 5 metrics are NOT independent. High RVOL days usually have high IB and high ATR_730 too. The 3-way cells have smaller samples and noisier estimates.</li>
              <li><span className="text-red-300 font-semibold">Trap pattern:</span> ATR_730_LOW + ATR_entry_HIGH. When the session starts quiet but volatility expands into the entry, the data shows directional losses (n=115, EV -$25). The clearest &quot;avoid&quot; condition.</li>
            </ul>
          </div>

          {vintage?.refreshed_at && (
            <div className="text-xs text-gray-500 border-t border-gray-800 pt-3">
              Lookup refreshed {formatDistanceToNowStrict(new Date(vintage.refreshed_at))} ago · {vintage.lookup_row_count} rows · {vintage.threshold_count} thresholds
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Style helpers
// ─────────────────────────────────────────────────────────────────────────────

function bucketTone(b: 'LOW' | 'HIGH' | null): string {
  if (b === 'LOW') return 'bg-blue-900/50 text-blue-200 border border-blue-800'
  if (b === 'HIGH') return 'bg-amber-900/50 text-amber-200 border border-amber-800'
  return 'bg-gray-900 text-gray-600 border border-gray-800'
}

function tertileTone(b: 'L' | 'M' | 'H' | null): string {
  if (b === 'L') return 'bg-blue-900/50 text-blue-200 border border-blue-800'
  if (b === 'M') return 'bg-gray-700 text-gray-200 border border-gray-600'
  if (b === 'H') return 'bg-amber-900/50 text-amber-200 border border-amber-800'
  return 'bg-gray-900 text-gray-600 border border-gray-800'
}
