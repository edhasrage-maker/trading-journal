'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Loader2, AlertTriangle } from 'lucide-react'
import {
  VERDICT_LABELS,
  VERDICT_DISPLAY,
  VERDICT_TONE,
  type LookupOutcome,
  type MatchResult,
} from '@/lib/condition-lookup'
import { MIN_SAMPLE, tooFewToJudge } from '@/lib/sample-size'
import type { ConditionMetric, ConditionVerdict, DailyPrep } from '@/lib/supabase/types'

/**
 * Morning prep condition filter — input 5 metrics, get a verdict, save the snapshot.
 */

// METRICS was the input-grid definition that fed the (now-removed) per-field
// inputs at the top of the panel. All four metrics auto-fill from Market
// Context now (DR_ADR moved to the Volatility row in MarketContextForm
// 2026-06-08), so the array was kept here only for reference but isn't read.
// Suppressed-unused-vars since the names + hints are useful documentation.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const METRICS: Array<{
  metric: ConditionMetric
  field: 'rvol' | 'dr_adr' | 'ib' | 'atr_730' | 'atr_entry'
  label: string
  placeholder: string
  hint: string
}> = [
  { metric: 'RVOL', field: 'rvol', label: 'RVOL', placeholder: '1.05', hint: 'Today\'s 6:30-7:30 volume / 10d avg of same window' },
  { metric: 'DR_ADR', field: 'dr_adr', label: 'DR vs ADR', placeholder: '0.60', hint: '(High-Low since 6:30) / 10d avg cash session range' },
  { metric: 'IB', field: 'ib', label: 'IB vs 10d Avg', placeholder: '0.93', hint: '(IBH-IBL) / 10d avg IB range' },
  { metric: 'ATR_730', field: 'atr_730', label: 'ATR-10 (1m)', placeholder: '18.0', hint: '1-min ATR-10 Wilder' },
  // ATR_entry retired: the live per-trade ATR-10 (added in a9f6161) renders
  // the manual-entry field obsolete. Kept the lookup-side bucket inert by
  // dropping the metric from this list — outcome.buckets no longer includes
  // it, so the pill row doesn't render the empty ATR_ENTRY chip.
]

// All four metrics (RVOL, DR_ADR, IB, ATR_730) auto-fill from Market Context
// now — DR_ADR moved into the Volatility Metrics row in MarketContextForm
// (2026-06-08). The panel no longer renders any input grid; it just renders
// the bucket pills + verdict + matched card from the looked-up values.

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
  /** Highlights (beginner) view: keep the metric cards but replace the grade
   *  verdict + full stats block with a slim Win rate + Profit factor readout.
   *  Detailed Tape (pro) shows the full panel. */
  beginner?: boolean
}

const EMPTY: InputState = { rvol: '', dr_adr: '', ib: '', atr_730: '', atr_entry: '' }

export default function ConditionFilterPanel({ date, marketContext, beginner = false }: Props) {
  const [inputs, setInputs] = useState<InputState>(EMPTY)
  const [outcome, setOutcome] = useState<LookupResponse | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  /** User can override the auto picker (which defaults to tertile, falls
   *  back to median when tertile has insufficient data) to inspect the
   *  other view. 'auto' = use the picker's choice. */
  const [viewOverride, setViewOverride] = useState<'auto' | 'median' | 'tertile'>('auto')
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

  // Effective pick reflects the auto-picker default UNLESS the user explicitly
  // overrode it. If the user picks a view that has no match, fall through to
  // whichever view does have one (don't silently render nothing).
  const autoPick = outcome?.consolidated.pick ?? 'tertile'
  const effectivePick: 'median' | 'tertile' = (() => {
    if (viewOverride === 'auto' || !outcome) return autoPick
    const want = viewOverride
    const wantHasMatch = want === 'median' ? !!outcome.best_median : !!outcome.best_tertile
    return wantHasMatch ? want : autoPick
  })()
  const effectiveMatch = outcome
    ? (effectivePick === 'tertile' ? outcome.best_tertile : outcome.best_median)
    : null
  const v: ConditionVerdict | null = effectiveMatch
    ? effectiveMatch.row.verdict
    : (outcome?.consolidated.verdict ?? null)
  const vintage = outcome?.vintage
  const vintageAge = vintage?.refreshed_at
    // eslint-disable-next-line react-hooks/purity
    ? Math.floor((Date.now() - new Date(vintage.refreshed_at).getTime()) / (1000 * 60 * 60 * 24))
    : null
  const vintageStale = vintageAge != null && vintageAge > 60

  // Nothing to look up: this day has none of the market-state metrics the
  // buckets are keyed on. That is the normal state for a trader who imports
  // trades but has never captured conditions (no bar feed / no prep auto-fill),
  // so it gets a real explanation rather than a dead panel.
  const hasAnyMetric = !!(
    effectiveInputs.rvol || effectiveInputs.dr_adr || effectiveInputs.ib || effectiveInputs.atr_730
  )

  return (
    <div className="space-y-5">
      {/* Provenance — no card chrome; the enclosing section owns the heading. */}
      <div className="flex items-center gap-3 text-xs flex-wrap -mt-1">
        <button
          onClick={() => setShowInfo(true)}
          className="text-blue-400 hover:text-blue-300 transition-colors"
        >
          How this works
        </button>
        {vintage?.refreshed_at && (
          <span
            className={`font-mono ${vintageStale ? 'text-yellow-400' : 'text-gray-500'}`}
            title={vintage.refreshed_at}
          >
            · lookup {vintageAge === 0 ? 'refreshed today' : `${vintageAge}d old`}
            {vintageStale && ' · stale'}
          </span>
        )}
        {lastSavedAt && saveStatus === 'saved' && (
          <span className="text-gray-500" title={new Date(lastSavedAt).toLocaleString()}>
            · snapshot saved
          </span>
        )}
      </div>

      <div className="space-y-5">
        {!hasAnyMetric && !lookingUp && (
          <div className="border-l-2 border-gray-700 pl-4 py-1 max-w-[64ch]">
            <p className="text-sm text-gray-300 leading-normal">
              No conditions captured for this day yet, so there is nothing to compare against.
            </p>
            <p className="text-xs text-gray-500 mt-1.5 leading-normal">
              This read is keyed on the morning market state — relative volume, range used, opening
              range and bar volatility. Those fill in automatically once the day&apos;s bars are
              available, or you can enter them in Market context above.
            </p>
          </div>
        )}
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

        {/* DR_ADR manual-input removed from here 2026-06-08 — it now lives
            in the Market Context Volatility Metrics row below as the 4th
            input alongside Rvol/ADR/ATR-10. The dr_adr ratio is derived in
            PrepClient from context.day_range / context.adr (set when the
            new input writes back), and ConditionFilterPanel reads it via
            marketContext.dr_adr same as before. */}

        {/* The raw 4-metric readout grid (RVOL/DR_ADR/IB/ATR cards) moved to
            the Today's Tape card above this panel (2026-07-12, item 14) —
            verdict chips lead, raw numbers sit behind its "show raw numbers"
            disclosure. This panel now starts at the verdict. */}

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

        {/* Consolidated verdict + view-override dropdown.
            Default picker is tertile (more specific match for today's conditions);
            user can override to inspect the median view when they want a wider
            sample. The select sits inside the verdict card so the connection
            between the verdict and which-view-drove-it is unmissable. */}
        {v && outcome && !beginner && (
          <ConsolidatedVerdict
            verdict={v}
            outcome={outcome}
            effectivePick={effectivePick}
            viewOverride={viewOverride}
            onChangeOverride={setViewOverride}
            isOverridden={viewOverride !== 'auto' && viewOverride !== autoPick}
          />
        )}

        {/* Highlights (beginner): just the two numbers that matter to a quick
            read — how often you win + your profit factor in conditions like
            today. The grade, EV, sample sizes, and view mechanics stay in
            Detailed Tape. */}
        {beginner && outcome && effectiveMatch && (
          <ConditionsHighlight match={effectiveMatch} />
        )}

        {/* Conflict warning — Detailed Tape only (it's a sample-mechanics note). */}
        {!beginner && outcome?.conflict && outcome.conflict_reason && (
          <div className="bg-orange-950/40 border border-orange-800 rounded-lg px-3 py-2 flex items-start gap-2 text-xs text-orange-200">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-orange-400" />
            <div>
              <div className="font-semibold text-orange-300 mb-0.5">Conflict</div>
              {outcome.conflict_reason}
            </div>
          </div>
        )}

        {/* Detailed Tape stat readout — the SAME clean cards as Highlights, plus
            EV/trade. The grade verdict + which-view-drove-it + the view-switch
            dropdown all live in the banner above; the previous dense per-view
            stats table (CI ranges, sessions, total PnL, condition id, vs-your-avg
            delta) was retired in favor of this simpler read. */}
        {!beginner && outcome && effectiveMatch && (
          <ConditionsHighlight match={effectiveMatch} showEv baselineEv={outcome.baseline_ev} />
        )}

        {/* Notes + Save */}
        <div className="space-y-2 pt-3 border-t border-gray-800">
          <label className="block text-xs text-gray-500">Notes (optional)</label>
          <textarea
            rows={2}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="What you're watching, plan deviations, etc."
            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none"
          />
          <div className="flex items-center justify-end gap-3">
            {saveStatus === 'error' && (
              <span className="text-xs text-red-400">Save failed</span>
            )}
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 border border-gray-700 hover:border-gray-600 rounded px-2.5 py-1.5 transition-colors disabled:opacity-60"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
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

// formatMetricValue + BucketReadout (the raw metric card grid) were removed
// 2026-07-12 — the verdict-first conditions read owns that surface. As of the
// Pt 14 Prep redesign that read lives in the page hero (PrepHero), which
// absorbed the old Today's Tape card.

function ConsolidatedVerdict({
  verdict,
  outcome,
  effectivePick,
  viewOverride,
  onChangeOverride,
  isOverridden,
}: {
  verdict: ConditionVerdict
  outcome: LookupOutcome
  effectivePick: 'median' | 'tertile'
  viewOverride: 'auto' | 'median' | 'tertile'
  onChangeOverride: (v: 'auto' | 'median' | 'tertile') => void
  isOverridden: boolean
}) {
  const tone = VERDICT_TONE[verdict]
  // Colour carries trading meaning only — the verdict word is tinted, the
  // surface is not. The old washed panel + emoji was the loudest remaining
  // "AI dashboard" tell on the prep page.
  const rule = tone === 'good'
    ? 'border-green-700'
    : tone === 'bad'
      ? 'border-red-700'
      : tone === 'neutral'
        ? 'border-yellow-700'
        : 'border-gray-700'
  const verdictColor = tone === 'good'
    ? 'text-green-400'
    : tone === 'bad'
      ? 'text-red-400'
      : tone === 'neutral'
        ? 'text-yellow-400'
        : 'text-gray-300'
  // Show a per-view explanation when overridden so the user understands why
  // the verdict changed when they toggled.
  const explanation = isOverridden
    ? `${effectivePick === 'tertile' ? 'Specific' : 'Broad'} match (manual override)`
    : outcome.consolidated.explanation
  return (
    <div className={`border-l-2 pl-4 py-1 ${rule}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <div>
          <div
            className={`text-[26px] font-bold tracking-[-0.02em] leading-tight ${verdictColor}`}
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {VERDICT_LABELS[verdict]}
          </div>
          <div className="text-xs text-gray-400 mt-0.5" title={`Internal code: ${verdict}`}>{VERDICT_DISPLAY[verdict]}</div>
        </div>
        <div className="text-left sm:text-right text-xs text-gray-500 space-y-1.5">
          <div className="font-mono">{explanation}</div>
          {/* Override dropdown — small, only visible when there's something
              to switch to (both views have a match). */}
          {outcome.best_median && outcome.best_tertile && (
            <div className="flex items-center gap-1.5 sm:justify-end">
              <span className="text-[10px] uppercase tracking-wider text-gray-600">View:</span>
              <select
                value={viewOverride}
                onChange={e => onChangeOverride(e.target.value as 'auto' | 'median' | 'tertile')}
                className="bg-gray-900 border border-gray-700 text-gray-300 text-[11px] rounded px-1.5 py-0.5 font-mono focus:outline-none focus:border-blue-500"
                title="Pick which historical view drives the verdict. Auto uses the better-sampled match; Specific matches today's conditions more tightly, Broad trades precision for a larger sample."
              >
                <option value="auto">Auto (best match)</option>
                <option value="tertile">Specific match</option>
                <option value="median">Broad match</option>
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Big-stat readout for a matched historical bucket. Win rate + Profit factor
 *  always; EV/trade (expectancy, avg $/trade) is added when `showEv` is set.
 *  Highlights (beginner) uses the 2-stat form; Detailed Tape uses the same card
 *  WITH EV/trade so the pro view reads like Highlights plus expectancy.
 *  `baselineEv` (Detailed Tape only) draws the "vs your avg" delta under EV.
 *  Every read carries its sample size; below MIN_SAMPLE the stats are
 *  suppressed entirely — a confident WR from 6 trades is false precision. */
function ConditionsHighlight({ match, showEv = false, baselineEv }: { match: MatchResult; showEv?: boolean; baselineEv?: number | null }) {
  const r = match.row
  const n = r.n_trades ?? 0
  if (n < MIN_SAMPLE) {
    return (
      <div>
        <SampleHeader n={n} thin />
        <p className="text-xs text-gray-500 max-w-[62ch] leading-normal border-t border-gray-800 pt-2">
          <span className="font-mono text-gray-400">{tooFewToJudge(n)}</span>
          {' — '}not enough trades in conditions like today to say anything honest yet.
          Numbers appear at {MIN_SAMPLE}+.
        </p>
      </div>
    )
  }
  const wr = r.trade_wr != null ? `${(r.trade_wr * 100).toFixed(0)}%` : '—'
  const pf = r.profit_factor != null ? r.profit_factor.toFixed(2) : '—'
  const pfTone = r.profit_factor == null
    ? 'text-gray-300'
    : r.profit_factor >= 1 ? 'text-green-400' : 'text-red-400'
  const ev = r.ev_per_trade != null
    ? `${r.ev_per_trade >= 0 ? '+' : '−'}$${Math.abs(r.ev_per_trade).toFixed(0)}`
    : '—'
  const evTone = r.ev_per_trade == null
    ? 'text-gray-300'
    : r.ev_per_trade > 0 ? 'text-green-400' : r.ev_per_trade < 0 ? 'text-red-400' : 'text-gray-400'
  return (
    <div>
      <SampleHeader n={n} />
      {/* Hairline rows, not a KPI card row — the boxed three-stat grid is the
          single most recognisable AI-dashboard move, and the locked language
          reads numbers as tabular display numerals on rules instead. */}
      <div className="grid gap-x-10 md:grid-cols-2">
      <StatRow label="Win rate" value={wr} note="in conditions like today" />
      {showEv && (
        <StatRow label="EV / trade" value={ev} valueTone={evTone} note="avg $ in conditions like today">
          {/* EV vs the trader's OWN baseline EV — flags whether THIS environment
              runs above/below your average. Bold when the bucket's EV CI clears
              the baseline entirely (statistically distinct), faint otherwise. */}
          {baselineEv != null && r.ev_per_trade != null && (() => {
            const delta = r.ev_per_trade - baselineEv
            const sigAbove = r.ev_ci_lo != null && r.ev_ci_lo > baselineEv
            const sigBelow = r.ev_ci_hi != null && r.ev_ci_hi < baselineEv
            const cls = sigAbove ? 'text-green-400' : sigBelow ? 'text-red-400' : delta >= 0 ? 'text-green-500/60' : 'text-gray-500'
            const weight = sigAbove || sigBelow ? 'font-semibold' : 'font-normal'
            return (
              <div
                className={`text-[10px] mt-1 ${cls} ${weight}`}
                title={`Your overall baseline EV is ${baselineEv >= 0 ? '+' : ''}$${baselineEv.toFixed(2)}/trade. ${sigAbove ? 'This environment is statistically ABOVE it — a favorable regime for you.' : sigBelow ? 'Statistically BELOW it — you underperform your average here.' : 'Within range of your average — no clear edge either way.'}`}
              >
                {Math.round(Math.abs(delta)) === 0
                  ? '≈ your average day'
                  : <>{delta >= 0 ? '↑' : '↓'} {delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(0)} vs your avg{!sigAbove && !sigBelow && ' (within range)'}</>}
              </div>
            )
          })()}
        </StatRow>
      )}
      <StatRow label="Profit factor" value={pf} valueTone={pfTone} note="in conditions like today" />
      </div>
    </div>
  )
}

/** One hairline stat row: label · display numeral · quiet note. Matches the
 *  market-context ledger so the two dense reads on Prep share a language. */
function StatRow({
  label, value, valueTone = 'text-gray-100', note, children,
}: {
  label: string
  value: string
  valueTone?: string
  note: string
  children?: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 items-baseline py-2 border-t border-gray-800">
      <span className="text-[13px] text-gray-400">{label}</span>
      <span
        className={`text-[17px] font-bold tabular-nums text-right ${valueTone}`}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </span>
      <span className="text-[11px] text-gray-500 col-span-2">{note}</span>
      {children && <div className="col-span-2">{children}</div>}
    </div>
  )
}

/** "You, on days like this" header + the n= badge every aggregate must carry. */
function SampleHeader({ n, thin = false }: { n: number; thin?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-1">
      <div className="text-[11px] text-gray-500">You, on days like this</div>
      {!thin && (
        <span className="font-mono text-[10px] text-gray-500">
          n={n} trades
        </span>
      )}
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
          <p>Today&apos;s market-state metrics (RVOL, DR vs ADR, IB, ATR-10), computed at the end of the Initial Balance. The lookup table tells you whether your historical edge in similar market conditions is positive, negative, or noise.</p>

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

// bucketTone / tertileTone removed 2026-06-08 — they styled the med:/ter:
// chips on each metric card, which were dropped from BucketReadout as
// internal-shorthand that didn't add value to the trader's read.
