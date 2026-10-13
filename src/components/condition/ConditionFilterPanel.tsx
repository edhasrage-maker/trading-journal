'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Loader2, AlertTriangle } from 'lucide-react'
import { type LookupOutcome, type MatchResult } from '@/lib/condition-lookup'
import type { Lead, LeadsResult } from '@/lib/condition-leads'
import { MIN_SAMPLE, tooFewToJudge } from '@/lib/sample-size'
import type { ConditionMetric, DailyPrep } from '@/lib/supabase/types'

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
  field: 'rvol' | 'dr_adr' | 'ib' | 'atr_730' | 'ib_atr'
  label: string
  placeholder: string
  hint: string
}> = [
  { metric: 'RVOL', field: 'rvol', label: 'RVOL', placeholder: '1.05', hint: 'Today\'s 6:30-7:30 volume / 10d avg of same window' },
  { metric: 'DR_ADR', field: 'dr_adr', label: 'DR vs ADR', placeholder: '0.60', hint: '(High-Low since 6:30) / 10d avg cash session range' },
  { metric: 'IB', field: 'ib', label: 'IB vs 10d Avg', placeholder: '0.93', hint: '(IBH-IBL) / 10d avg IB range' },
  { metric: 'ATR_730', field: 'atr_730', label: 'ATR vs typical', placeholder: '1.00', hint: 'IB-close 1-min ATR-10 / its own 10-day average' },
  { metric: 'IB_ATR', field: 'ib_atr', label: 'IB vs ATR (character)', placeholder: '9.3', hint: '(IBH-IBL) / meanHL10 — choppy < 7.7, expanded >= 13' },
  // ATR_entry was retired here (the live per-trade ATR-10 added in a9f6161 made
  // the manual field obsolete) and its slot was reused for IB_ATR in Pt 23 —
  // the metric was never populated, so 105 of every 236 lookup rows constrained
  // a null. Day character now fills that dimension instead.
]

// All four metrics (RVOL, DR_ADR, IB, ATR_730) auto-fill from Market Context
// now — DR_ADR moved into the Volatility Metrics row in MarketContextForm
// (2026-06-08). The panel no longer renders any input grid; it just renders
// the bucket pills + verdict + matched card from the looked-up values.

interface VintageInfo {
  refreshed_at: string | null
  lookup_row_count: number
  threshold_count: number
  /** Set when the trader has deliberately narrowed the history the buckets are
   *  built from. Null = all history. Surfaced so a small n reads as a choice. */
  history_start_date?: string | null
}

interface LookupResponse extends LookupOutcome {
  vintage: VintageInfo
}

interface InputState {
  rvol: string
  dr_adr: string
  ib: string
  atr_730: string
  ib_atr: string
}

/**
 * Values from the prep page's Market Context, already put on the SAME basis and
 * in the SAME unit that condition-lookup-refresh bucketed the history on. The
 * caller owns that alignment (see PrepClient's Morning Conditions block) —
 * anything passed here is fed to the lookup unconverted.
 */
interface MarketContextPrefill {
  /** RVOL at the 07:30 PT IB close, EOD RVOL as fallback. */
  rvol?: number | null
  ib_vs_10d_avg?: number | null
  /** ATR_730 as a RATIO — the 07:29 PT IB-close Wilder ATR-10 over its own
   *  trailing-10 average (atrIbCloseRatio). Scale-free, so the same cuts are
   *  valid on NQ and ES; a normal day is ~1.0. */
  atr_730?: number | null
  /** DR/ADR as a PERCENT (75.9 = 75.9% of a normal day's range), matching
   *  condition_thresholds.DR_ADR. */
  dr_adr?: number | null
  /** Day character (IB range / meanHL10), persisted by the prep page once the
   *  IB has printed. Buckets the trader's history by choppy / mid / expanded. */
  ib_atr_ratio?: number | null
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

const EMPTY: InputState = { rvol: '', dr_adr: '', ib: '', atr_730: '', ib_atr: '' }

export default function ConditionFilterPanel({ date, marketContext, beginner = false }: Props) {
  const [inputs, setInputs] = useState<InputState>(EMPTY)
  const [outcome, setOutcome] = useState<LookupResponse | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  /** User can override the auto picker (which defaults to tertile, falls
   *  back to median when tertile has insufficient data) to inspect the
   *  other view. 'auto' = use the picker's choice. */
  const [viewOverride, setViewOverride] = useState<'auto' | 'median' | 'tertile'>('auto')
  const [migrationNeeded, setMigrationNeeded] = useState(false)
  /** This quarter's forward tests (see condition-leads.ts). Null until loaded;
   *  a failed load leaves it null and the block simply doesn't render. */
  const [leads, setLeads] = useState<LeadsResult | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // "Effective" inputs — the user-typed value if present, otherwise the
  // Market Context value for the three overlapping fields. Computed at render
  // time so updates to Market Context flow through automatically; user-typed
  // values always win.
  const fromContext = (raw: number | null | undefined): string =>
    raw != null && Number.isFinite(raw) ? String(raw) : ''
  const effectiveInputs: InputState = {
    rvol: inputs.rvol || fromContext(marketContext?.rvol),
    // Derived only, like atr_730 below. Saved snapshots hold day-range ÷ ADR (and
    // before that a bare ratio); the metric is now IB range ÷ ADR, a different
    // quantity under the same name, so a restored value would be bucketed on
    // the wrong basis.
    dr_adr: fromContext(marketContext?.dr_adr),
    ib: inputs.ib || fromContext(marketContext?.ib_vs_10d_avg),
    // Deliberately NOT `inputs.atr_730 || ...`. Snapshots saved before
    // 2026-10-08 hold ATR_730 in raw POINTS (prod: 14 rows, 2.97-44.26) and it
    // is now a ratio (~1.0). Unlike dr_adr, a stored points value cannot be
    // converted back — the denominator was never saved with it — and the two
    // ranges overlap (an ES day's 2.97 points is a plausible-looking ratio), so
    // there is no sniff that is safe. The metric is fully derived from
    // market_context anyway, so the live value simply wins and the column
    // self-heals on the next save.
    atr_730: fromContext(marketContext?.atr_730),
    ib_atr: inputs.ib_atr || fromContext(marketContext?.ib_atr_ratio),
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
          ib_atr: p.ib_atr != null ? String(p.ib_atr) : '',
        }
        setInputs(next)
        setLastSavedAt(new Date(p.updated_at).getTime())
        setSaveStatus('saved')
      } catch {
        // silent
      }
    })()
    return () => { cancelled = true }
  }, [date])

  // ── Debounced lookup on input change ──────────────────────────────────────
  const runLookup = useCallback(async (state: InputState) => {
    const parsed = {
      rvol: parseFloat(state.rvol),
      dr_adr: parseFloat(state.dr_adr),
      ib: parseFloat(state.ib),
      atr_730: parseFloat(state.atr_730),
      ib_atr: parseFloat(state.ib_atr),
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
        ib_atr: Number.isFinite(parsed.ib_atr) ? parsed.ib_atr : null,
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

  const runLeads = useCallback(async (state: InputState) => {
    const n = (v: string) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null }
    try {
      const res = await fetch('/api/condition-leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rvol: n(state.rvol), dr_adr: n(state.dr_adr), ib: n(state.ib), atr_730: n(state.atr_730), ib_atr: n(state.ib_atr) }),
      })
      if (!res.ok) { setLeads(null); return }
      setLeads(await res.json() as LeadsResult)
    } catch { setLeads(null) }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const snapshot = effectiveInputs
    debounceRef.current = setTimeout(() => { void runLookup(snapshot); if (!beginner) void runLeads(snapshot) }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // Dep array intentionally tracks the merged values so lookup re-fires when
    // either user input or Market Context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveInputs.rvol, effectiveInputs.dr_adr, effectiveInputs.ib, effectiveInputs.atr_730, effectiveInputs.ib_atr, runLookup, runLeads, beginner])

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
        ib_atr: parse(effectiveInputs.ib_atr),
        matched_median_condition_id: outcome?.best_median?.row.condition_id ?? null,
        matched_tertile_condition_id: outcome?.best_tertile?.row.condition_id ?? null,
        consolidated_verdict: outcome?.consolidated.verdict ?? null,
        conflict_flag: outcome?.conflict ?? false,
        // `notes` intentionally omitted — see the Save block below.
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
        {/* A narrowed history makes every n smaller. Say so, or it reads as
            missing data instead of a deliberate window. */}
        {vintage?.history_start_date && (
          <span
            className="font-mono text-gray-500"
            title={`Condition buckets are built only from sessions on or after ${vintage.history_start_date}. Clear condition_lookup_meta.history_start_date to use all history.`}
          >
            · from {vintage.history_start_date}
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

        {/* The read, said plainly. There is no grade: a letter and an instruction
            ("Grade C · Be selective") were shown on nearly every morning, and the
            trader's whole book earned the same grade — it described the trader,
            not the day. What can honestly be said is whether days like this one
            have run differently from the trader's average, and usually they
            have not. */}
        {outcome && effectiveMatch && !beginner && (
          <DayRead
            match={effectiveMatch}
            outcome={outcome}
            effectivePick={effectivePick}
            viewOverride={viewOverride}
            onChangeOverride={setViewOverride}
            isOverridden={viewOverride !== 'auto' && viewOverride !== autoPick}
          />
        )}

        {/* The five readings the comparison is made on, so the trader can see
            why today landed where it did. All are 07:30 PT (IB close) values. */}
        {!beginner && hasAnyMetric && <ConditionStrip inputs={effectiveInputs} />}

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
          <ConditionsHighlight match={effectiveMatch} showEv baselineEv={outcome.baseline_ev} baseline={outcome.baseline} />
        )}

        {/* Forward tests — what is being watched this quarter and how it has
            done since it was picked. Detailed Tape only. */}
        {!beginner && leads && <TrackedLeads result={leads} />}

        {/* Save. The notes textarea that used to live here was removed
            2026-07-27 — the prep page already owns free-text ("what you're
            watching, plan deviations") and asking for it twice on the same
            screen just made the trader choose a box. `daily_prep.notes` and its
            API field are untouched, and the POST below deliberately OMITS the
            key (the route only writes `notes` when present), so notes saved
            before the removal survive rather than being nulled on the next save. */}
        <div className="space-y-2 pt-3 border-t border-gray-800">
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

type ReadState = 'thin' | 'same' | 'above' | 'below'

/** Where the matched bucket sits against the trader's own average: only
 *  'above' / 'below' when its whole 95% range clears that average. */
function readState(match: MatchResult, baselineEv: number | null): ReadState {
  const r = match.row
  if ((r.n_trades ?? 0) < MIN_SAMPLE || baselineEv == null) return 'thin'
  if (r.ev_ci_lo != null && r.ev_ci_lo > baselineEv) return 'above'
  if (r.ev_ci_hi != null && r.ev_ci_hi < baselineEv) return 'below'
  return 'same'
}

const READ_COPY: Record<ReadState, { head: string; sub: string | null; color: string; rule: string }> = {
  thin: { head: 'Too few trades to say.', sub: null, color: 'text-gray-400', rule: 'border-gray-700' },
  same: {
    head: 'No different from your average.',
    sub: 'Nothing in today’s conditions separates your results from your average.',
    color: 'text-gray-300', rule: 'border-gray-700',
  },
  above: {
    head: 'Above your average so far.',
    sub: 'In your history only — a lead to watch, not a rule. It has not been tested on new trades.',
    color: 'text-green-400', rule: 'border-green-700',
  },
  below: {
    head: 'Below your average so far.',
    sub: 'In your history only — a lead to watch, not a rule. It has not been tested on new trades.',
    color: 'text-red-400', rule: 'border-red-700',
  },
}

function DayRead({
  match,
  outcome,
  effectivePick,
  viewOverride,
  onChangeOverride,
  isOverridden,
}: {
  match: MatchResult
  outcome: LookupOutcome
  effectivePick: 'median' | 'tertile'
  viewOverride: 'auto' | 'median' | 'tertile'
  onChangeOverride: (v: 'auto' | 'median' | 'tertile') => void
  isOverridden: boolean
}) {
  const copy = READ_COPY[readState(match, outcome.baseline_ev)]
  // Show a per-view explanation when overridden so the user understands why
  // the read changed when they toggled.
  const explanation = isOverridden
    ? `${effectivePick === 'tertile' ? 'Specific' : 'Broad'} match (manual override)`
    : outcome.consolidated.explanation
  return (
    <div className={`border-l-2 pl-4 py-1 ${copy.rule}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <div>
          <div
            className={`text-[22px] font-bold tracking-[-0.02em] leading-tight ${copy.color}`}
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {copy.head}
          </div>
          {copy.sub && <div className="text-xs text-gray-400 mt-1 max-w-[58ch] leading-normal">{copy.sub}</div>}
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
                title="Pick which slice of your history today is compared with. Auto uses the better-sampled match; Specific matches today's conditions more tightly, Broad trades precision for a larger sample."
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

/** The five 07:30 PT readings today is compared on. */
function ConditionStrip({ inputs }: { inputs: InputState }) {
  const num = (s: string) => { const x = parseFloat(s); return Number.isFinite(x) ? x : null }
  const rvol = num(inputs.rvol), dr = num(inputs.dr_adr), ib = num(inputs.ib), atr = num(inputs.atr_730), ibAtr = num(inputs.ib_atr)
  const items: Array<[string, string | null, string]> = [
    ['RVOL at IB close', rvol != null ? rvol.toFixed(0) : null, 'Volume through the IB close vs your 10-day average for the same hour (100 = normal).'],
    ['IB ÷ ADR', dr != null ? `${dr.toFixed(0)}%` : null, 'How much of a normal day’s range the opening hour already used: IB range ÷ ADR.'],
    ['IB vs 10-day', ib != null ? `${ib.toFixed(2)}×` : null, 'Today’s IB range ÷ its own 10-day average.'],
    ['ATR vs typical', atr != null ? `${atr.toFixed(2)}×` : null, '1-minute ATR at the IB close ÷ its own 10-day average at the same moment.'],
    ['IB ÷ ATR', ibAtr != null ? ibAtr.toFixed(1) : null, 'IB range ÷ the average range of the last ten IB bars — low is choppy, high is clean.'],
  ]
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10.5px] text-gray-500">
      {items.map(([label, value, title]) => (
        <span key={label} title={title}>
          {label} <b className="font-medium text-gray-300">{value ?? '—'}</b>
        </span>
      ))}
    </div>
  )
}

const money = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(0)}`)
const pfText = (v: number | null) => (v == null ? '—' : v.toFixed(2))
const shortDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/**
 * This quarter's forward tests. A lead is a condition whose results cleared the
 * trader's average in the sessions BEFORE the quarter began; what matters is
 * the second half of each row — what it has done on trades taken since, which
 * had no part in choosing it.
 */
function TrackedLeads({ result }: { result: LeadsResult }) {
  const since = shortDate(result.freezeDate)
  return (
    <div className="pt-4 border-t border-gray-800">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
        <span className="text-[13px] font-bold tracking-[-0.01em] text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
          Being tracked this quarter
        </span>
        <span className="font-mono text-[10.5px] text-gray-500">
          picked from sessions before {since} · scored on trades since
        </span>
      </div>

      {result.status === 'not-enough-history' && (
        <p className="text-xs text-gray-500 max-w-[64ch] leading-normal">
          Not enough history before {since} to pick anything worth tracking yet. Leads appear on their own once
          one has 30 trades across 10 sessions behind it.
        </p>
      )}
      {result.status === 'no-leads' && (
        <p className="text-xs text-gray-400 max-w-[64ch] leading-normal">
          Nothing cleared your average before {since}, so nothing is being tracked. That is a real answer — no
          condition has run clearly better or worse for you.
        </p>
      )}

      {result.leads.map(lead => (
        <LeadRow key={lead.condition_id} lead={lead} since={since} baseline={result.pickedBaseline} />
      ))}

      {result.status === 'ok' && (
        <p className="text-[11px] text-gray-500 mt-2 max-w-[70ch] leading-normal">
          These are hypotheses, not findings. When this was tested, conditions picked this way kept their direction
          on new trades less than half the time — which is why each one is scored going forward before it is believed.
        </p>
      )}
    </div>
  )
}

function LeadRow({ lead, since, baseline }: { lead: Lead; since: string; baseline: LeadsResult['pickedBaseline'] }) {
  const tone = lead.side === 'above' ? 'text-green-400' : 'text-red-400'
  const f = lead.forwardIn, o = lead.forwardOut
  const forwardWord =
    lead.forwardState === 'holding' ? 'holding so far'
      : lead.forwardState === 'not-holding' ? 'not holding so far'
        : 'too few to judge'
  const forwardTone =
    lead.forwardState === 'holding' ? 'text-gray-100'
      : lead.forwardState === 'not-holding' ? 'text-yellow-400'
        : 'text-gray-500'
  return (
    <div className="py-2.5 border-t border-gray-800">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="text-[13.5px] font-semibold text-gray-100">
          {lead.name}
          {lead.matchesDay === true && (
            <span className="ml-2 font-mono text-[9px] tracking-wider text-yellow-400 border border-yellow-700 rounded-sm px-1 align-[1px]">THIS SESSION</span>
          )}
        </span>
        <span className="font-mono text-[10.5px] text-gray-500">
          {lead.matchesDay === false ? 'this session is not in it' : lead.matchesDay == null ? 'needs the IB close to check' : ''}
        </span>
      </div>
      <div className="font-mono text-[10px] text-gray-500 mt-0.5">{lead.cuts.map(c => c.text).join(' · ')}</div>
      <div className="grid gap-x-10 gap-y-1 md:grid-cols-2 mt-2 text-xs">
        <div className="text-gray-400">
          <span className="text-gray-500">When picked </span>
          <b className={`font-bold tabular-nums ${tone}`}>{money(lead.picked.ev)}</b> a trade over {lead.picked.n} trades
          {' '}({lead.picked.sessions} sessions), PF {pfText(lead.picked.pf)}
          <span className="text-gray-500"> · your average then {money(baseline.ev)}, PF {pfText(baseline.pf)}</span>
        </div>
        <div className="text-gray-400">
          <span className="text-gray-500">Since {since} </span>
          {f.n === 0
            ? <>no trades inside it yet</>
            : <><b className="font-bold tabular-nums text-gray-100">{money(f.ev)}</b> a trade over {f.n} ({f.sessions} sessions), PF {pfText(f.pf)}</>}
          <span className="text-gray-500"> · everything else {o.n === 0 ? '—' : `${money(o.ev)} over ${o.n}, PF ${pfText(o.pf)}`}</span>
          <span className={`font-semibold ${forwardTone}`}> · {forwardWord}</span>
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
function ConditionsHighlight({ match, showEv = false, baselineEv, baseline }: { match: MatchResult; showEv?: boolean; baselineEv?: number | null; baseline?: LookupOutcome['baseline'] }) {
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
      <StatRow label="Win rate" value={wr} note={baseline?.wr != null ? `vs ${(baseline.wr * 100).toFixed(0)}% across all ${baseline.n} trades` : 'in conditions like today'} />
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
      <StatRow label="Profit factor" value={pf} valueTone={pfTone} note={baseline?.pf != null ? `vs ${baseline.pf.toFixed(2)} across all ${baseline.n} trades` : 'in conditions like today'} />
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
          <h3 className="font-semibold text-white">How Morning conditions works</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white">✕</button>
        </div>
        <div className="text-sm text-gray-300 space-y-3">
          <p>Five readings taken at the close of the Initial Balance (07:30 PT) describe the morning: relative volume, how much of a normal day&apos;s range the opening hour used, the size of the IB against its 10-day average, bar size against its own typical, and how choppy the IB was. Your past trades on mornings with similar readings are compared with your average across all trades.</p>

          <div>
            <div className="font-semibold text-white text-sm mb-1">What the read says</div>
            <ul className="space-y-1 text-xs">
              <li><span className="text-gray-200">No different from your average</span> — the usual answer. Days like today have not run clearly better or worse for you.</li>
              <li><span className="text-green-400">Above</span> / <span className="text-red-400">Below your average so far</span> — the whole 95% range of those trades sits on one side of your average. It is a description of your history, not a prediction.</li>
              <li><span className="text-gray-400">Too few trades to say</span> — fewer than {MIN_SAMPLE} trades on days like today.</li>
            </ul>
          </div>

          <div>
            <div className="font-semibold text-white text-sm mb-1">Being tracked this quarter</div>
            <p className="text-xs text-gray-400">A condition that cleared your average before the quarter began is tracked through it, and scored only on trades taken since. That second number is the one to trust: a pattern found by searching your history is right about new trades less than half the time, so nothing here is treated as an edge until it has held up going forward. A new quarter picks again from everything before it.</p>
          </div>

          <div>
            <div className="font-semibold text-white text-sm mb-1">Caveats</div>
            <ul className="space-y-1.5 text-xs list-disc list-inside text-gray-400">
              <li>There is no grade and no instruction. Earlier versions showed a letter grade on every morning; it was the same grade your whole book earned, so it described you rather than the day.</li>
              <li>Every reading is knowable at 07:30 PT. Nothing here uses how the day finished.</li>
              <li>Each trade is compared on its own instrument&apos;s readings, and all five are ratios, so NQ and ES mornings are measured on the same scale.</li>
              <li>The readings are not independent — busy mornings tend to have large opening ranges and big bars too — and the more specific a match, the smaller its sample.</li>
              <li>This looks only at market conditions. It does not consider your setup, order flow, or state of mind.</li>
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
