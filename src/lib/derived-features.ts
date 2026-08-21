import type { TradeLike } from '@/lib/analytics'

/**
 * Non-tag features — the patterns the trader did NOT write down.
 *
 * A tag is the trader's own input. Telling them "your revenge trades lose
 * money" is telling them something they typed. The information is in what they
 * didn't type: WHEN the trade was taken, HOW LONG after the last one, how wide
 * the stop was, whether it repeated the direction that just failed.
 *
 * These become findings on their own, and — more usefully — they combine with a
 * tag. On the owner's book "Revenge Trading" is -0.18R, which is unactionable
 * ("stop revenge trading"). Split by one derived feature it becomes: revenge
 * re-entered within 5 minutes is -0.48R at 14% win, revenge re-entered later is
 * +0.38R at 43%. Same tag, opposite conclusions, and the second version names
 * an action the trader can actually take.
 *
 * ── THE ENTRY-TIME RULE ──
 * Every feature here must be KNOWABLE AT THE MOMENT OF ENTRY. That is both a
 * statistical guard and a product one:
 *   - statistically, features only known at exit are entangled with the outcome.
 *     "Held under 3 minutes" looks like the strongest signal in the book
 *     (-0.48R, 13% win across 83 trades) but a trade that loses fast IS a short
 *     trade, so most of that gap is the outcome explaining the feature rather
 *     than the other way round.
 *   - practically, a finding the trader can't act on at entry isn't advice.
 * Hold time, exit price and post-exit continuation are therefore deliberately
 * excluded from finding generation, however tempting the numbers look.
 */

/** Facts about a trade that were all true before it was placed. */
export interface EntryFeatures {
  /** 1-based position within its own session. */
  seq: number
  /** Minutes between the previous trade's exit and this entry; null for the
   *  day's first trade or when either timestamp is missing. */
  gapMin: number | null
  /** The previous trade in the session lost. */
  afterLoss: boolean
  /** The previous trade lost AND this one repeats its direction. */
  sameDirAfterLoss: boolean
  /** Planned stop distance in ATR units at entry. */
  stopAtr: number | null
  /** Planned reward:risk from the trader's own TP1 and stop. */
  plannedRr: number | null
  /** 5m structure alignment recorded at import. */
  align: 'following' | 'fading' | 'neutral' | null
}

type FeatureTrade = TradeLike & {
  exit_time?: string | null
  tp1_price?: number | null
  entry_atr_1m?: number | null
  structure_5m_alignment?: 'following' | 'fading' | 'neutral' | null
}

/**
 * Derive per-trade entry features. Needs the whole window at once because
 * sequence and gap are defined relative to the rest of the session.
 */
export function deriveEntryFeatures(trades: FeatureTrade[]): Map<string, EntryFeatures> {
  const out = new Map<string, EntryFeatures>()

  // Group by session, then order by entry time so "previous trade" means what
  // the trader experienced, not whatever order the rows arrived in.
  const byDay = new Map<string, FeatureTrade[]>()
  for (const t of trades) {
    const key = t.trading_day_id ?? '_'
    const arr = byDay.get(key) ?? []
    arr.push(t)
    byDay.set(key, arr)
  }

  for (const list of byDay.values()) {
    list.sort((a, b) => String(a.entry_time ?? '').localeCompare(String(b.entry_time ?? '')))
    list.forEach((t, i) => {
      const prev = i > 0 ? list[i - 1] : null
      const gapMin = prev?.exit_time && t.entry_time
        ? (Date.parse(t.entry_time) - Date.parse(prev.exit_time)) / 60000
        : null
      const afterLoss = prev != null && (prev.pnl ?? 0) < 0
      const riskPts = t.entry_price != null && t.stop_price != null
        ? Math.abs(t.entry_price - t.stop_price)
        : null

      out.set(t.id, {
        seq: i + 1,
        // A negative gap means overlapping positions (a scale-in), not a
        // re-entry — treat it as unmeasurable rather than as "instant".
        gapMin: gapMin != null && gapMin >= 0 ? gapMin : null,
        afterLoss,
        sameDirAfterLoss: afterLoss && prev?.direction != null && prev.direction === t.direction,
        stopAtr: riskPts != null && t.entry_atr_1m ? riskPts / t.entry_atr_1m : null,
        plannedRr: riskPts != null && riskPts > 0 && t.tp1_price != null && t.entry_price != null
          ? Math.abs(t.tp1_price - t.entry_price) / riskPts
          : null,
        align: t.structure_5m_alignment ?? null,
      })
    })
  }

  return out
}

export interface FeatureDef {
  key: string
  /** Completes "trades you <phrase>". */
  phrase: string
  /** Completes "<counterPhrase>" for the comparison arm. */
  counterPhrase: string
  /** What to do when this feature is the COSTLY side of the split. */
  costlyAction: string
  /** What to do when it turns out to be the PROFITABLE side. A feature that
   *  sounds like a leak isn't always one — "your third trade onward" is the bad
   *  half for most traders and the good half for this one on Break And Retest —
   *  so both directions need their own instruction. Reusing the corrective
   *  wording produced findings that praised a behaviour and then told the
   *  trader to stop it. */
  protectAction: string
  /** null = this trade can't be classified either way, so it joins neither arm. */
  test: (f: EntryFeatures) => boolean | null
}

/**
 * The feature set. Deliberately small and each one defensible as a decision the
 * trader makes at entry — not a fishing expedition. Every extra feature is
 * another chance to surface noise, so they earn their place individually.
 */
export const ENTRY_FEATURES: FeatureDef[] = [
  {
    key: 'reentry-fast',
    phrase: 'took within 5 minutes of your last exit',
    counterPhrase: 'waited longer than 5 minutes',
    costlyAction: 'After an exit, give it five minutes before the next entry.',
    protectAction: 'The immediate continuation is working here — keep taking it when the setup is already there.',
    test: f => (f.gapMin == null ? null : f.gapMin <= 5),
  },
  {
    key: 'same-dir-after-loss',
    phrase: 'took in the same direction straight after a loss',
    counterPhrase: 'every other entry',
    costlyAction: 'After a loss, the same direction needs a fresh trigger — not the same idea again.',
    protectAction: 'Re-taking that direction after a loss is paying — keep backing the read when the level holds.',
    test: f => (f.seq === 1 ? null : f.sameDirAfterLoss),
  },
  {
    key: 'third-plus',
    phrase: 'took as your third trade of the day or later',
    counterPhrase: 'your first two',
    costlyAction: 'Set a trade count for the day before the open and stop there.',
    protectAction: 'Your later entries are the good ones — do not cut the session short after two.',
    test: f => f.seq >= 3,
  },
  {
    key: 'tight-stop',
    phrase: 'gave less than half an ATR of room',
    counterPhrase: 'wider stops',
    costlyAction: 'Size down rather than tighten the stop inside half an ATR.',
    protectAction: 'The tight stop is working — keep the risk small on these.',
    test: f => (f.stopAtr == null ? null : f.stopAtr < 0.5),
  },
  {
    key: 'wide-target',
    phrase: 'targeted 3R or more',
    counterPhrase: 'closer targets',
    costlyAction: 'The far target is not paying here — take the closer one.',
    protectAction: 'Keep setting the far target — it is carrying your results.',
    test: f => (f.plannedRr == null ? null : f.plannedRr >= 3),
  },
  {
    key: 'fading-structure',
    phrase: 'took against the 5m structure',
    counterPhrase: 'trades with the structure',
    costlyAction: 'Take the setup with 5m structure behind it, not into it.',
    protectAction: 'Fading structure is working on this one — keep it selective.',
    test: f => (f.align == null || f.align === 'neutral' ? null : f.align === 'fading'),
  },
]
