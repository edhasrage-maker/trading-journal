/**
 * SESSION FACTS — every number the EOD model kept getting wrong, computed once,
 * deterministically, so it can quote instead of calculate.
 *
 * WHY THIS EXISTS. A live analysis (2026-07-28) got roughly half its specific
 * figures wrong while every field it merely READ was fine. The errors were all
 * arithmetic done in prose:
 *   "3/3 ES supply/demand trades hit TP"        → 2/3 (one stopped out)
 *   "T1→T2 was 60s, T8→T9 was 2 minutes"        → 44s and 84s
 *   "the gap lengthens as the state stabilizes" → 44 → 86 → 84, no trend at all
 *   "T3, T7, T9 each list 4-7 confluences"      → T3 lists 2
 *   "T8 … only 0.5 pts of favorable move"       → 2.0 pts
 * The prompt already had the cure in one place and never generalized it — see
 * the `plannedR` comment in eod-prompt.ts: "Precomputed … so the AI doesn't have
 * to do the division (it kept miscounting)". This is that idea for the rest.
 *
 * The block is also the reference the post-hoc checker grades the output
 * against (checkFactClaims in ai-constraints.ts), so a wrong tally is caught
 * even when the prompt is ignored. PURE — no I/O, fully unit-tested.
 */

import { symbolRoot } from '@/lib/futures-symbols'

/** The subset of a trade these facts need. Widened by callers (Trade fits). */
export interface FactTrade {
  entry_time?: string | null
  exit_time?: string | null
  symbol?: string | null
  direction?: 'long' | 'short' | null
  entry_price?: number | null
  pnl?: number | null
  quantity?: number | null
  high_during_position?: number | null
  low_during_position?: number | null
  entry_atr_1m?: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json?: any
}

export interface InstrumentTally {
  root: string
  n: number
  wins: number
  losses: number
  /** Exactly-zero P&L. Counted apart so wins+losses+scratches === n always. */
  scratches: number
  pnl: number
}

export interface ReentryGap {
  /** 1-based trade numbers, matching the T-numbers in the prompt's trade list. */
  from: number
  to: number
  /** Seconds from the PRIOR trade's EXIT to this trade's ENTRY — the same
   *  realized-loss-aware basis P4 (cooldown) uses. Null if either time missing. */
  seconds: number | null
  /** Was the prior trade a realized loss? Only then is the gap a cooldown. */
  afterLoss: boolean
}

export interface TradeFacts {
  idx: number
  root: string
  win: boolean | null
  /** Tag counts per category — the model kept miscounting these by eye. */
  confluences: number
  setups: number
  mistakes: number
  emotions: number
  /** Favorable excursion in points and ×ATR, direction-aware. Null when the
   *  excursion columns or entry price are missing. */
  mfePts: number | null
  mfeAtr: number | null
}

export interface SessionFacts {
  n: number
  wins: number
  losses: number
  scratches: number
  pnl: number
  byInstrument: InstrumentTally[]
  gaps: ReentryGap[]
  trades: TradeFacts[]
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/** Count a tag array defensively — tags_json shapes vary across importers. */
function tagCount(tags: unknown, key: string): number {
  if (!tags || typeof tags !== 'object') return 0
  const v = (tags as Record<string, unknown>)[key]
  return Array.isArray(v) ? v.length : v ? 1 : 0
}

export function computeSessionFacts(trades: FactTrade[]): SessionFacts {
  // Trade numbers must match the prompt's list, which renders in the order it is
  // given. Do NOT re-sort here or T4 in the facts stops being T4 in the prose.
  const facts: TradeFacts[] = []
  const tallies = new Map<string, InstrumentTally>()
  const gaps: ReentryGap[] = []
  let wins = 0, losses = 0, scratches = 0, pnl = 0

  trades.forEach((t, i) => {
    const root = t.symbol ? symbolRoot(t.symbol) : '—'
    const p = t.pnl == null ? null : Number(t.pnl)
    const win = p == null ? null : p > 0
    if (p != null) {
      pnl += p
      if (p > 0) wins++
      else if (p < 0) losses++
      else scratches++
    }
    const tal = tallies.get(root) ?? { root, n: 0, wins: 0, losses: 0, scratches: 0, pnl: 0 }
    tal.n++
    if (p != null) {
      tal.pnl += p
      if (p > 0) tal.wins++
      else if (p < 0) tal.losses++
      else tal.scratches++
    }
    tallies.set(root, tal)

    // Favorable excursion, direction-aware: a long's best is the high.
    let mfePts: number | null = null
    if (t.entry_price != null && t.direction) {
      const extreme = t.direction === 'long' ? t.high_during_position : t.low_during_position
      if (extreme != null) {
        const raw = t.direction === 'long' ? extreme - t.entry_price : t.entry_price - extreme
        mfePts = round2(Math.max(0, raw))
      }
    }
    const atr = t.entry_atr_1m != null && t.entry_atr_1m > 0 ? t.entry_atr_1m : null

    facts.push({
      idx: i + 1,
      root,
      win,
      confluences: tagCount(t.tags_json, 'confluences'),
      setups: tagCount(t.tags_json, 'setups'),
      mistakes: tagCount(t.tags_json, 'mistakes'),
      emotions: tagCount(t.tags_json, 'emotions'),
      mfePts,
      mfeAtr: mfePts != null && atr ? round2(mfePts / atr) : null,
    })

    // Re-entry gap from the PREVIOUS trade's exit. Consecutive pairs only —
    // that is what "T1→T2 was 60s" is claiming, and it is what P4 measures.
    if (i > 0) {
      const prev = trades[i - 1]
      const prevExit = prev.exit_time ? Date.parse(prev.exit_time) : NaN
      const thisEntry = t.entry_time ? Date.parse(t.entry_time) : NaN
      const ok = Number.isFinite(prevExit) && Number.isFinite(thisEntry)
      gaps.push({
        from: i,
        to: i + 1,
        seconds: ok ? Math.round((thisEntry - prevExit) / 1000) : null,
        afterLoss: prev.pnl != null && Number(prev.pnl) < 0,
      })
    }
  })

  return {
    n: trades.length,
    wins, losses, scratches,
    pnl: round2(pnl),
    byInstrument: [...tallies.values()].sort((a, b) => b.n - a.n),
    gaps,
    trades: facts,
  }
}

/** The prompt block. Framed as the ONLY quotable source for these numbers —
 *  the model may still reason, it just may not re-derive. */
export function sessionFactsBlock(f: SessionFacts): string {
  if (f.n === 0) return ''
  const tallies = f.byInstrument
    .map(t => `${t.root}: ${t.wins}W/${t.losses}L${t.scratches ? `/${t.scratches}S` : ''} of ${t.n} (${t.pnl >= 0 ? '+' : ''}$${round2(t.pnl)})`)
    .join(' | ')
  const gapLines = f.gaps
    .map(g => `T${g.from}→T${g.to}: ${g.seconds == null ? 'unknown' : `${g.seconds}s`}${g.afterLoss ? ' (prior trade was a LOSS)' : ''}`)
    .join(', ')
  const tradeLines = f.trades
    .map(t => `T${t.idx} ${t.root} ${t.win === null ? 'n/a' : t.win ? 'WIN' : 'LOSS'} — confluences ${t.confluences}, setups ${t.setups}, mistakes ${t.mistakes}, emotions ${t.emotions}, MFE ${t.mfePts == null ? 'n/a' : `${t.mfePts}pt`}${t.mfeAtr == null ? '' : ` (${t.mfeAtr}×ATR)`}`)
    .join('\n  ')

  return `
══ SESSION FACTS (PRECOMPUTED — QUOTE THESE, NEVER RECALCULATE) ══

Every count, tally, gap and excursion below is computed deterministically from
the trade rows. These are the ONLY numbers of this kind you may state. Do NOT
count tags by eye, do NOT add up wins yourself, do NOT convert times to
durations — past analyses got roughly half of those wrong while every field
they simply read was correct.

  Session: ${f.n} trades, ${f.wins}W/${f.losses}L${f.scratches ? `/${f.scratches}S` : ''}, net ${f.pnl >= 0 ? '+' : ''}$${round2(f.pnl)}
  By instrument: ${tallies}
  Re-entry gaps (prior EXIT → next ENTRY): ${gapLines || 'n/a (single trade)'}
  Per trade:
  ${tradeLines}

If a number you want to state is not in this block and not a raw field on the
trade line, you do not have it — say so rather than estimating.

NO INVENTED TRENDS. "The gap lengthens", "quality improves through the session"
and similar progressions require the values to ACTUALLY be monotone — check them
against the list above before writing one. Picking three values out of a longer
list to make a trend appear is the same error: if the full sequence isn't
monotone, the trend isn't there.${f.gaps.length ? `\nToday's gap sequence in order: ${f.gaps.map(g => g.seconds == null ? '?' : `${g.seconds}s`).join(' → ')}. Describe it as it is.` : ''}`
}
