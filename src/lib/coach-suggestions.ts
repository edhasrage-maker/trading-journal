// Deterministic "what should I work on?" topics for the coach's proactive
// opener (Pt 11). Ranks the trader's weakest signals from their own data and
// templates the top few into clickable improvement topics — NO model call, so
// every number is real and it can never invent a leak. Same deterministic ethos
// as the trust layer + follow/fade suggestion.
//
// Split in two: `rankSuggestions` is PURE (signals → ranked topics) and
// unit-tested; `gatherCoachSignals` does the lean queries. The /api/coach/
// suggestions route wires them together for the empty-state opener.

import { followFade, type Regime } from '@/lib/market-structure'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const fmt$ = (n: number) => (n >= 0 ? '+' : '−') + '$' + Math.abs(Math.round(n)).toLocaleString()
const pct = (n: number) => `${Math.round(n)}%`
/** Strip a leading ordinal like "1. " that Tradezella day-types/mistakes carry. */
const stripNumPrefix = (s: string) => s.replace(/^\s*\d+\.\s*/, '').trim()

/** The weak-signal candidates the ranker scores. All optional — a clean or new
 *  account may surface none, and the opener degrades to a generic greeting. */
export interface CoachSignals {
  /** Mistake tag with the most negative summed P&L over the window. */
  costliestMistake?: { label: string; pnl: number; count: number }
  /** Worst day-type by average realized P&L (negative only). */
  worstDayType?: { label: string; avgPnl: number; days: number }
  /** Process-breach frequency over analyzed days. */
  breach?: { breachDays: number; analyzedDays: number }
  /** 5m follow-vs-fade win-rate skew (native trades with an alignment). */
  structureSkew?: { better: 'following' | 'fading'; betterWr: number; worseWr: number; n: number }
}

export interface Suggestion {
  /** Stable id for React keys / analytics. */
  id: string
  /** The one-line topic shown in the opener (grounded, with real numbers). */
  line: string
  /** What gets sent to the coach when the trader clicks "dig in". */
  followUp: string
  /** 0..1 severity used only for ranking; not shown. */
  score: number
}

// Only surface a candidate once it clears a floor, so a disciplined trader
// isn't handed trivial "leaks". Severity is normalized 0..1 per signal type.
const FLOOR = 0.15

/**
 * Rank the trader's weak signals and template the top `max` (default 3) into
 * clickable improvement topics. PURE — deterministic in its input, no I/O. Order
 * is by severity desc; ties broken by a fixed signal priority so output is
 * stable across runs.
 */
export function rankSuggestions(signals: CoachSignals, max = 3): Suggestion[] {
  const cands: (Suggestion & { prio: number })[] = []

  if (signals.costliestMistake && signals.costliestMistake.pnl < 0) {
    const { label, pnl, count } = signals.costliestMistake
    cands.push({
      id: 'costliest-mistake',
      score: Math.min(1, Math.abs(pnl) / 1000),
      prio: 4,
      line: `“${label}” is your costliest leak — ${fmt$(pnl)} across ${count} tagged trade${count === 1 ? '' : 's'}.`,
      followUp: `Why do my trades tagged “${label}” lose money, and how do I stop it?`,
    })
  }

  if (signals.worstDayType && signals.worstDayType.avgPnl < 0) {
    const { label, avgPnl, days } = signals.worstDayType
    cands.push({
      id: 'worst-day-type',
      score: Math.min(1, Math.abs(avgPnl * days) / 1000),
      prio: 3,
      line: `You bleed on ${label} days — averaging ${fmt$(avgPnl)} across ${days} of them.`,
      followUp: `How should I trade ${label} days differently — or should I sit them out?`,
    })
  }

  if (signals.breach && signals.breach.analyzedDays >= 5) {
    const { breachDays, analyzedDays } = signals.breach
    const rate = breachDays / analyzedDays
    cands.push({
      id: 'process-breach',
      score: rate,
      prio: 2,
      line: `You broke process on ${breachDays} of ${analyzedDays} analyzed days (${pct(rate * 100)}).`,
      followUp: `Which safety rails do I breach most often, and how do I tighten up?`,
    })
  }

  if (signals.structureSkew && signals.structureSkew.n >= 20) {
    const { better, betterWr, worseWr, n } = signals.structureSkew
    const edge = betterWr - worseWr
    cands.push({
      id: 'structure-skew',
      score: Math.min(1, edge / 30),
      prio: 1,
      line: `You're clearly better ${better} 5m structure — ${pct(betterWr)} vs ${pct(worseWr)} win rate over ${n} trades.`,
      followUp: `Should I focus on trades that ${better === 'following' ? 'follow' : 'fade'} the 5m structure and skip the rest?`,
    })
  }

  return cands
    .filter(c => c.score >= FLOOR)
    .sort((a, b) => (b.score - a.score) || (b.prio - a.prio))
    .slice(0, max)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ prio, ...s }) => s)
}

/**
 * Gather the weak signals from the trader's last-`days` window (default 180).
 * Lean queries mirroring buildCoachContext's definitions (mistake P&L = summed
 * pnl on trades carrying that mistake tag; follow/fade via structure_5m_alignment;
 * breach via eod_ai_analysis_json.process.verdict). Best-effort — any query
 * failure just omits that signal.
 */
export async function gatherCoachSignals(supabase: AnyClient, opts: { startDate: string; endDate: string }): Promise<CoachSignals> {
  const { startDate, endDate } = opts
  const out: CoachSignals = {}

  // Days: worst day-type by avg eod_pnl + breach frequency.
  try {
    const { data: days } = await supabase
      .from('trading_days')
      .select('id, day_types, eod_pnl, eod_ai_analysis_json')
      .gte('date', startDate).lte('date', endDate)
    const dayRows = (days ?? []) as Array<{ id: string; day_types: string[] | null; eod_pnl: number | null; eod_ai_analysis_json: { process?: { verdict?: string } } | null }>

    const dtBuckets = new Map<string, { pnl: number; days: number }>()
    let breachDays = 0, analyzedDays = 0
    for (const d of dayRows) {
      if (d.eod_pnl != null && Array.isArray(d.day_types)) {
        for (const raw of d.day_types) {
          const label = stripNumPrefix(String(raw))
          if (!label) continue
          const b = dtBuckets.get(label) ?? { pnl: 0, days: 0 }
          b.pnl += d.eod_pnl; b.days += 1; dtBuckets.set(label, b)
        }
      }
      const verdict = d.eod_ai_analysis_json?.process?.verdict
      if (verdict === 'Compliant' || verdict === 'Breach') {
        analyzedDays += 1
        if (verdict === 'Breach') breachDays += 1
      }
    }
    let worst: CoachSignals['worstDayType']
    for (const [label, b] of dtBuckets) {
      if (b.days < 3) continue   // need a few sessions before calling a day-type a weakness
      const avg = b.pnl / b.days
      if (avg < 0 && (!worst || avg < worst.avgPnl)) worst = { label, avgPnl: avg, days: b.days }
    }
    if (worst) out.worstDayType = worst
    if (analyzedDays > 0) out.breach = { breachDays, analyzedDays }
  } catch { /* omit day-derived signals */ }

  // Trades: costliest mistake tag + 5m follow/fade win-rate skew.
  try {
    const { data: trades } = await supabase
      .from('trades')
      .select('pnl, direction, tags_json, structure_5m_regime')
      .gte('entry_time', `${startDate}T00:00:00`).lte('entry_time', `${endDate}T23:59:59`)
      .limit(5000)
    const rows = (trades ?? []) as Array<{ pnl: number | null; direction: 'long' | 'short' | null; tags_json: { mistakes?: string[] } | null; structure_5m_regime: string | null }>

    const mistakes = new Map<string, { pnl: number; count: number }>()
    // Follow/fade from the DENSE pivot regime + direction (same read as the
    // Follow/Fade LTF structure tag), not the sparse EMA-20 alignment field.
    const ff = new Map<'follow' | 'fade', { wins: number; n: number }>()
    for (const t of rows) {
      const pnl = t.pnl ?? 0
      for (const raw of (t.tags_json?.mistakes ?? [])) {
        const label = stripNumPrefix(String(raw))
        if (!label) continue
        const b = mistakes.get(label) ?? { pnl: 0, count: 0 }
        b.pnl += pnl; b.count += 1; mistakes.set(label, b)
      }
      if (t.direction && t.structure_5m_regime) {
        const side = followFade(t.direction, t.structure_5m_regime as Regime)
        if (side === 'follow' || side === 'fade') {
          const b = ff.get(side) ?? { wins: 0, n: 0 }
          if (pnl > 0) b.wins += 1
          b.n += 1; ff.set(side, b)
        }
      }
    }

    let costly: CoachSignals['costliestMistake']
    for (const [label, b] of mistakes) {
      if (b.pnl < 0 && (!costly || b.pnl < costly.pnl)) costly = { label, pnl: b.pnl, count: b.count }
    }
    if (costly) out.costliestMistake = costly

    const fo = ff.get('follow'), fa = ff.get('fade')
    if (fo && fa && fo.n >= 10 && fa.n >= 10) {
      const foWr = (fo.wins / fo.n) * 100, faWr = (fa.wins / fa.n) * 100
      const better = foWr >= faWr ? 'following' : 'fading'
      out.structureSkew = {
        better,
        betterWr: Math.max(foWr, faWr),
        worseWr: Math.min(foWr, faWr),
        n: fo.n + fa.n,
      }
    }
  } catch { /* omit trade-derived signals */ }

  return out
}
