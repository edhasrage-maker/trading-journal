// Server-side write path for the materialized per-day dashboard rollup (Pt 10).
// Fetches one day's inputs, runs the SHARED pure computeDayStats, and persists
// the projected rollup to trading_days.stats_json (+ stats_version). Because it
// uses the same computeDayStats the dashboard reads with, a cached row and a
// freshly-computed row are byte-identical by construction.
//
// Runs under the CALLER's Supabase client, so RLS scopes reads + the write to
// that user's own rows. Wired into the mutation points (import, analyze-eod,
// analyze-prep, trade edit/delete, market-context write) as a best-effort warm;
// the DB triggers (migration 20260718) + the dashboard read-through keep results
// correct even if a recompute here is skipped.
//
// IMPORTANT: the write is a SEPARATE update touching only stats_json/
// stats_version, so the BEFORE UPDATE invalidation trigger (which only fires on
// input-column changes) preserves the value we just wrote. Never fold this into
// the same update as an ai_analysis_json / eod_pnl / day_types mutation.

import {
  computeDayStats, dayRiskSums, toStoredStats, STATS_VERSION, ROLLUP_TRADE_COLS, RISK_SUMS_SINCE_VERSION, RISK_SQ_SINCE_VERSION,
  type DayForStats, type TradeForStats,
} from './day-stats'
import { AVG_RISK_WINDOW_TRADES, normalizeAtrStopTarget, type RiskDay } from './exit-rollup'
import { includeFlowScoreInEntry, resolveRubric, type ScoringProfile } from './scoring-profile'
import { readEntryRules, type EntryRuleConfig } from './entry-rules'
import { readRunnerRules, type RunnerRuleConfig } from './runner-rules'
import { traderRulesSig } from './exit-rollup'
import { pickMarketContext } from './market-context-select'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

// The exact trade columns computeDayStats reads — shared with every other
// query that feeds the rollup.
const TRADE_COLS = ROLLUP_TRADE_COLS

/** The scoring-profile settings TapeScore reads. */
export interface TapeScoreSettings {
  /** The ATR stop setting (`stop: { mode: 'atr', value }`; default 1) — the
   *  yardstick for Risk's "Stop size". Baked into the cached sums. */
  atrStopTarget: number
  /** Include the order-flow Score in Entry (default ON). Applied at read time. */
  includeFlow: boolean
  /** The trader's entry rules (`entry_rules`; none = []) — Entry's "Entry
   *  rules" part. Baked into the cached sums; `rulesSig` says which. */
  entryRules: EntryRuleConfig[]
  /** The trader's runner rules (`runner_rules`; none = []) — Exit's "Runner rules"
   *  part on the trades where one counts. Baked into the cached sums. */
  runnerRules: RunnerRuleConfig[]
  /** traderRulesSig of both: what a cached day must have been computed with. */
  rulesSig: string
}

/** What the cached day sums are computed with — a cached row made with anything else is stale. */
export type StatsBake = Pick<TapeScoreSettings, 'atrStopTarget' | 'entryRules' | 'runnerRules' | 'rulesSig'>

/**
 * The trader's TapeScore settings from their scoring profile, in one read. The
 * ATR stop setting is resolved through the same `resolveRubric` the trade Score
 * uses, so the two can't read it differently. Never throws: a DB without the
 * column (the local owner build) or a missing row is the defaults.
 */
export async function loadTapeScoreSettings(supabase: AnyClient): Promise<TapeScoreSettings> {
  const defaults: TapeScoreSettings = { atrStopTarget: 1, includeFlow: includeFlowScoreInEntry(null), entryRules: [], runnerRules: [], rulesSig: '' }
  try {
    const { data, error } = await supabase
      .from('trader_profile').select('scoring_profile_json').eq('id', 'default').maybeSingle()
    if (error || !data) return defaults
    const sp = data.scoring_profile_json && typeof data.scoring_profile_json === 'object'
      ? (data.scoring_profile_json as ScoringProfile) : null
    return {
      atrStopTarget: normalizeAtrStopTarget(resolveRubric(sp).atrStopTarget),
      includeFlow: includeFlowScoreInEntry(sp),
      ...rulesOf(sp),
    }
  } catch {
    return defaults
  }
}

function rulesOf(sp: ScoringProfile | null): { entryRules: EntryRuleConfig[]; runnerRules: RunnerRuleConfig[]; rulesSig: string } {
  const entryRules = readEntryRules(sp?.entry_rules)
  const runnerRules = readRunnerRules(sp?.runner_rules)
  return { entryRules, runnerRules, rulesSig: traderRulesSig(entryRules, runnerRules) }
}

/** Just what the per-day write path bakes into the cache: the ATR stop setting and the trader's own rules. */
export async function loadStatsBake(supabase: AnyClient): Promise<StatsBake> {
  const { atrStopTarget, entryRules, runnerRules, rulesSig } = await loadTapeScoreSettings(supabase)
  return { atrStopTarget, entryRules, runnerRules, rulesSig }
}

/** Prior days fetched per round trip while looking for 30 stop trades. */
const RISK_HISTORY_PAGE = 60
/** Hard stop on how far back the search goes (pages). */
const RISK_HISTORY_MAX_PAGES = 6

/**
 * The days BEFORE `beforeDate` that the risk-yardstick rule can reach (see
 * src/lib/exit-rollup.ts): newest first, as many as it takes to cover 30 trades
 * with a logged stop. Each is just { date, summed planned $ risk, its sum of
 * squares, count } — what the mean and SD need.
 *
 * Cost: ONE query in steady state — the newest 60 prior day rows, reading only
 * the three risk numbers out of each cached `stats_json` (a JSON-path select, so
 * the blobs never leave the database). A second query (lean trade columns)
 * runs only for prior days whose cache is missing; a further page only for a
 * trader with fewer than 30 stop trades in their last 60 sessions.
 *
 * Never throws; on any failure it returns what it has (worst case nothing,
 * which reads as "no yardstick yet" — each loss is then measured against its
 * own planned risk).
 */
export async function loadRiskHistory(supabase: AnyClient, beforeDate: string): Promise<RiskDay[]> {
  const out: RiskDay[] = []
  try {
    let covered = 0
    for (let page = 0; page < RISK_HISTORY_MAX_PAGES && covered < AVG_RISK_WINDOW_TRADES; page++) {
      const from = page * RISK_HISTORY_PAGE
      type Row = { id: string; date: string; stats_version?: number | null; risk?: number | null; sq?: number | null; n?: number | null }
      let rows: Row[] = []
      const cached = await supabase
        .from('trading_days')
        .select('id, date, stats_version, risk:stats_json->sum_risk_dollars, sq:stats_json->sum_risk_sq, n:stats_json->risk_sample')
        .lt('date', beforeDate)
        .order('date', { ascending: false })
        .range(from, from + RISK_HISTORY_PAGE - 1)
      if (!cached.error) {
        rows = (cached.data ?? []) as Row[]
      } else {
        // No stats columns (a DB before the materialization migration): every
        // day is read from its trades instead.
        const plain = await supabase
          .from('trading_days')
          .select('id, date')
          .lt('date', beforeDate)
          .order('date', { ascending: false })
          .range(from, from + RISK_HISTORY_PAGE - 1)
        if (plain.error) break
        rows = (plain.data ?? []) as Row[]
      }
      if (rows.length === 0) break

      const usable = (r: Row) =>
        (r.stats_version ?? 0) >= Math.max(RISK_SUMS_SINCE_VERSION, RISK_SQ_SINCE_VERSION)
        && typeof r.risk === 'number' && typeof r.sq === 'number' && typeof r.n === 'number'
      const missing = rows.filter(r => !usable(r)).map(r => r.id)
      const fromTrades = new Map<string, { sum_risk_dollars: number; sum_risk_sq: number; risk_sample: number }>()
      if (missing.length > 0) {
        type Lean = Pick<TradeForStats, 'pnl' | 'entry_price' | 'stop_price' | 'quantity' | 'symbol' | 'direction' | 'stops'> & { trading_day_id: string }
        const byDay = new Map<string, Lean[]>()
        for (let p = 0; p < 20; p++) {
          const { data, error } = await supabase
            .from('trades')
            .select('trading_day_id, pnl, entry_price, stop_price, quantity, symbol, direction, stops:review_json->stops')
            .in('trading_day_id', missing)
            .order('id', { ascending: true })
            .range(p * 1000, p * 1000 + 999)
          if (error) break
          const batch = (data ?? []) as Lean[]
          for (const t of batch) {
            const arr = byDay.get(t.trading_day_id) ?? []
            arr.push(t)
            byDay.set(t.trading_day_id, arr)
          }
          if (batch.length < 1000) break
        }
        for (const id of missing) fromTrades.set(id, dayRiskSums(byDay.get(id) ?? []))
      }

      for (const r of rows) {
        const sums = usable(r)
          ? { sum_risk_dollars: r.risk as number, sum_risk_sq: r.sq as number, risk_sample: r.n as number }
          : fromTrades.get(r.id) ?? { sum_risk_dollars: 0, sum_risk_sq: 0, risk_sample: 0 }
        out.push({ date: r.date, ...sums })
        covered += sums.risk_sample
      }
      if (rows.length < RISK_HISTORY_PAGE) break
    }
  } catch (e) {
    console.error('[day-stats] loadRiskHistory failed:', e)
  }
  return out
}

const DAY_COLS =
  'id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json'

/**
 * Recompute + persist one day's stats_json. Best-effort: never throws — logs and
 * returns false on any failure (a missing column on a pre-migration DB, an RLS
 * denial for a read-only demo user, etc.) so it can't break the mutation it
 * hangs off of. Returns true when the cache was written.
 */
export async function recomputeDayStats(supabase: AnyClient, dayId: string): Promise<boolean> {
  try {
    if (!dayId) return false
    const dayRes = await supabase.from('trading_days').select(DAY_COLS).eq('id', dayId).maybeSingle()
    const day = dayRes?.data as DayForStats | null | undefined
    if (!day) return false

    const [tradesRes, ctxRes, bake] = await Promise.all([
      supabase.from('trades').select(TRADE_COLS).eq('trading_day_id', dayId),
      // One context row per instrument — fetch all + pick by the day's traded
      // instrument. Picking the wrong one badly skews the ×ATR fallback (ES
      // atr_1m ~2 vs NQ ~10). See src/lib/market-context-select.ts.
      supabase.from('market_context').select('symbol, atr_1m').eq('trading_day_id', dayId),
      // Risk's "Stop size" and Entry's "Entry rules" are graded against the trader's own settings.
      loadStatsBake(supabase),
    ])
    const trades = (tradesRes?.data ?? []) as TradeForStats[]
    const prepAtr = pickMarketContext((ctxRes?.data as { symbol: string | null; atr_1m: number | null }[] | null) ?? [], trades)?.atr_1m ?? null

    const rollup = computeDayStats(day, trades, prepAtr, { atrStopTarget: bake.atrStopTarget, entryRules: bake.entryRules, runnerRules: bake.runnerRules })
    const { error } = await supabase
      .from('trading_days')
      .update({ stats_json: toStoredStats(rollup), stats_version: STATS_VERSION })
      .eq('id', dayId)
    if (error) {
      // Missing column (pre-migration) or any write error → leave the cache
      // null; the read-through recomputes it. Don't surface it.
      console.warn('[day-stats] recompute write skipped:', error.message ?? error)
      return false
    }
    return true
  } catch (e) {
    console.error('[day-stats] recomputeDayStats failed:', e)
    return false
  }
}

/**
 * Recompute + persist for a day resolved by DATE (the common route case — most
 * mutation handlers hold the date, not the trading_days id). No-ops cleanly when
 * the day row doesn't exist yet.
 */
export async function recomputeDayStatsByDate(supabase: AnyClient, date: string): Promise<boolean> {
  try {
    if (!date) return false
    const res = await supabase.from('trading_days').select('id').eq('date', date).maybeSingle()
    const id = res?.data?.id as string | undefined
    if (!id) return false
    return await recomputeDayStats(supabase, id)
  } catch (e) {
    console.error('[day-stats] recomputeDayStatsByDate failed:', e)
    return false
  }
}
