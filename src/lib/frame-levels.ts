/**
 * Reading the trader's PLANNED stop / target off a recording's ENTRY frame.
 *
 * Both recap paths (cloud `/api/recap/commentary`, local `/api/video/commentary`)
 * already ask the model for these levels alongside the written commentary. This
 * module holds the one shared version of that ask — the prompt block, the output
 * schema fragment, and the arithmetic/geometry guards that run on the answer —
 * so the two routes can't drift apart, and so the hard-won Sierra-reading rules
 * from `/api/extract-trade` live in one place instead of three.
 *
 * WHAT MAKES THIS PATH DIFFERENT FROM extract-trade
 * -------------------------------------------------
 * extract-trade reads a pasted screenshot cold: it has to work out the direction
 * and SOLVE the entry before it can place anything. Here both are already known
 * from the fill — the trade row is the ground truth. That flips the job from
 * "derive three numbers" to "place two numbers around a known one", and it makes
 * the guards genuinely stronger: a level can be checked against the REAL entry
 * instead of against another vision read.
 *
 * It also gives a free correctness signal. Every bracket order's label states
 * its distance from the fill in points, so `stop_price + stop_points` must come
 * back to the real entry. When it doesn't, the label was misread — we don't know
 * which half, so we stop trusting that whole read rather than pick a winner.
 *
 * WHY THE EXIT FRAME IS NEVER USED
 * --------------------------------
 * The bracket is usually gone by then (that's what closing the trade means), so
 * an exit frame offers nothing to read and plenty to misread.
 */

import { solveBracket } from './bracket-solve'
import { normalizeTradeLevels } from './trade-geometry'
import type { DetectedLevels } from './supabase/types'

/** The model's raw answer, before any guard has run. Mirrors DetectedLevels
 *  plus the two point distances we ask for so a missing leg can be solved. */
export interface RawFrameLevels {
  entry_price?: number | null
  stop_price?: number | null
  tp1_price?: number | null
  tp2_price?: number | null
  stop_points?: number | null
  tp1_points?: number | null
  confidence?: 'high' | 'medium' | 'low' | null
  reasoning?: string | null
}

/**
 * The PART-2 instruction block. Written to sit under a commentary prompt that
 * has already introduced the frames, and to be read alongside a trade-context
 * line stating the direction and fill price.
 *
 * Every rule here earned its place on a real misread — see
 * reference_chart_screenshot_cues and the extract-trade prompt it mirrors.
 */
export const FRAME_LEVELS_PROMPT_BLOCK = `From the ENTRY frame ONLY (never the exit frame — the bracket is normally gone by then), read the trader's PLANNED order levels off the labeled horizontal ORDER LINES on the chart. These are lines drawn across the price scale, NOT a DOM/depth ladder; do not describe them as being "on the DOM".

You are NOT being asked to work out the direction or the entry. Both are stated for you in the trade context below, taken from the actual fill — treat them as fact and place the stop and target around them.

Step 1 — TELL THE TWO LINES APART BY THEIR OWN P&L SIGN, not by the Buy/Sell letter.
On Sierra Chart the bracket orders are the OPPOSITE side of the position: a LONG is bracketed by SELL orders, a SHORT by BUY orders. So "S|Stop" does NOT mean short. Ignore the letter entirely. The reliable signal is the projected P&L printed in the label:
  - a POSITIVE value — "(+320.00C, 32.00p)" — is the TARGET (it books a profit)
  - a NEGATIVE value — "(-160.00C, 16.00p)" — is the STOP (it books a loss)
Colour is P&L too (green = profit, red = loss), never direction.

Step 2 — READ THE POINT DISTANCE INSIDE EACH LABEL. The "NN.NNp" figure is that order's distance from the fill. Report it unsigned as stop_points / tp1_points. This matters more than it looks: the axis price is small and often clipped at the pane edge, while the point figure sits inside the text you are already reading. When only one of the two is legible, report the one you can actually read and leave the other null — a level can be reconstructed from entry plus its distance, so a distance alone is still useful.

Step 3 — CHECK AGAINST THE STATED ENTRY. The label distances must reconcile with the fill price given in the trade context:
    LONG :  entry = stop_price + stop_points   AND  entry = tp1_price − tp1_points
    SHORT:  entry = stop_price − stop_points   AND  entry = tp1_price + tp1_points
If your numbers don't come back to the stated entry, you have misread a label — re-read it before answering.

Step 4 — GEOMETRY. The three prices always order as:
    LONG :  stop  <  entry  <  TP1
    SHORT:  TP1   <  entry  <  stop
A value on the wrong side of entry for the stated direction is a misread, not a finding.

Also ignore, as price levels: the position / P&L tile ("+5 P/L: 40.00C, 4.00p", "+$40.00 USD"), which sits at the CURRENT price and is never a level; and the "Trade: Qty@PRICE" readout, which is the last tape print, not your order. If the frame shows several chart panes of the same instrument, read the levels from whichever pane's order labels are legible and never mix values across panes.

CRITICAL: return null for any field you cannot actually read. DO NOT GUESS — the trader backfills their journal from these, and a wrong stop silently corrupts their risk and heat numbers for good. A null costs them one manual entry; a hallucinated number costs them a false read of their own trading.

confidence is "high" ONLY when every non-null price came off a clearly-labeled order line AND the distances reconcile with the stated entry; "medium" when a level was inferred from where a line sits rather than from its label; "low" when the frame was hard to read. Say in reasoning which lines you actually saw.`

/** JSON-schema fragment for the `detected_levels` object. Shared so both routes
 *  ask for the same shape — including the two point distances the guards need. */
export const FRAME_LEVELS_SCHEMA = {
  type: 'object',
  properties: {
    entry_price: { type: ['number', 'null'] },
    stop_price: { type: ['number', 'null'] },
    tp1_price: { type: ['number', 'null'] },
    tp2_price: { type: ['number', 'null'] },
    stop_points: { type: ['number', 'null'] },
    tp1_points: { type: ['number', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
  },
  required: ['entry_price', 'stop_price', 'tp1_price', 'tp2_price', 'stop_points', 'tp1_points', 'confidence', 'reasoning'],
  additionalProperties: false,
} as const

export interface GuardedFrameLevels {
  /** The cleaned read, safe to store and show. */
  levels: DetectedLevels
  /** What the guards changed, for the reasoning trail. Empty when the model's
   *  answer survived untouched. */
  notes: string[]
}

/** Half a point — inside one ES/NQ tick pair. Matches solveBracket's tolerance
 *  so "reconciles with the fill" means the same thing in both places. */
const TOL = 0.5
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/**
 * Clean one model answer against the trade's real direction and fill price.
 *
 * Order matters here:
 *   1. reconcile the label distances with the KNOWN entry — a mismatch means a
 *      misread label, so the whole read gets demoted rather than half-trusted
 *   2. complete a missing leg from entry + its own distance (solveBracket)
 *   3. un-swap a reversed pair, then null anything still wrong-sided
 *   4. null a level that equals entry — that's the model latching onto the
 *      current-price marker, and it makes RR meaningless
 *
 * `entryPrice` / `direction` come from the trade row, not from the model. When
 * either is missing we can only run the weakest checks, and the read is demoted
 * to "low" because nothing could be verified.
 */
export function guardFrameLevels(
  raw: RawFrameLevels | null | undefined,
  trade: { direction?: string | null; entry_price?: number | null },
): GuardedFrameLevels | null {
  if (!raw || typeof raw !== 'object') return null

  const notes: string[] = []
  const dir = trade.direction === 'long' || trade.direction === 'short' ? trade.direction : null
  const entry = num(trade.entry_price)
  let confidence: DetectedLevels['confidence'] =
    raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
      ? raw.confidence
      : 'low'

  let stop = num(raw.stop_price)
  let tp1 = num(raw.tp1_price)
  const tp2 = num(raw.tp2_price)
  const stopPts = num(raw.stop_points)
  const tp1Pts = num(raw.tp1_points)

  const demote = (to: DetectedLevels['confidence']) => {
    const rank = { low: 0, medium: 1, high: 2 } as const
    if (rank[to] < rank[confidence]) confidence = to
  }

  if (entry == null || dir == null) {
    // Nothing to verify against — keep what was read but never let it claim
    // high confidence, because the checks that would earn that never ran.
    demote('medium')
    notes.push('trade has no fill price/direction to check the read against')
    return {
      levels: { entry_price: entry ?? num(raw.entry_price), stop_price: stop, tp1_price: tp1, tp2_price: tp2, confidence, reasoning: buildReasoning(raw.reasoning, notes) },
      notes,
    }
  }

  // ── 1. Do the label distances come back to the real fill? ──────────────────
  const isLong = dir === 'long'
  const reconciles: boolean[] = []
  if (stop != null && stopPts != null) reconciles.push(Math.abs((isLong ? stop + stopPts : stop - stopPts) - entry) <= TOL)
  if (tp1 != null && tp1Pts != null) reconciles.push(Math.abs((isLong ? tp1 - tp1Pts : tp1 + tp1Pts) - entry) <= TOL)
  const conflicted = reconciles.some(ok => !ok)
  if (conflicted) {
    // One of {price, distance} was misread and there's no way to tell which, so
    // the honest move is to stop trusting the read rather than pick a winner.
    demote('low')
    notes.push('order-label distances do not reconcile with the actual fill price')
  }

  // ── 2. Complete a leg that has a distance but no readable price. ───────────
  if (!conflicted) {
    const solved = solveBracket({
      direction: dir, entry_price: entry,
      stop_price: stop, tp1_price: tp1,
      stop_points: stopPts, tp1_points: tp1Pts,
    })
    if (stop == null && solved.stop_price != null) {
      stop = solved.stop_price
      notes.push(`stop reconstructed from entry ${entry} and its ${stopPts}pt label`)
    }
    if (tp1 == null && solved.tp1_price != null) {
      tp1 = solved.tp1_price
      notes.push(`target reconstructed from entry ${entry} and its ${tp1Pts}pt label`)
    }
  }

  // ── 3. Geometry: un-swap a reversed pair, then null what's still wrong-sided.
  const unswapped = normalizeTradeLevels({ direction: dir, entry, stop, tp1 })
  if (unswapped.stop !== stop || unswapped.tp1 !== tp1) {
    notes.push('stop and target were the right levels the wrong way round — swapped back')
    demote('medium')
  }
  stop = unswapped.stop
  tp1 = unswapped.tp1
  if (stop != null && (isLong ? stop >= entry : stop <= entry)) {
    notes.push(`dropped a stop on the wrong side of a ${dir} entry`)
    stop = null
    demote('low')
  }
  if (tp1 != null && (isLong ? tp1 <= entry : tp1 >= entry)) {
    notes.push(`dropped a target on the wrong side of a ${dir} entry`)
    tp1 = null
    demote('low')
  }

  // ── 4. A level that IS the entry is the current-price marker, not a level. ─
  if (stop != null && Math.abs(stop - entry) < 1e-6) { stop = null; notes.push('dropped a stop equal to entry'); demote('low') }
  if (tp1 != null && Math.abs(tp1 - entry) < 1e-6) { tp1 = null; notes.push('dropped a target equal to entry'); demote('low') }

  return {
    levels: {
      // Report the REAL fill, not the model's echo of it — the trade row wins.
      entry_price: entry,
      stop_price: stop,
      tp1_price: tp1,
      tp2_price: tp2,
      confidence,
      reasoning: buildReasoning(raw.reasoning, notes),
    },
    notes,
  }
}

function buildReasoning(modelReasoning: string | null | undefined, notes: string[]): string {
  const base = typeof modelReasoning === 'string' ? modelReasoning.trim() : ''
  if (notes.length === 0) return base
  const checked = `Checked against the recorded fill: ${notes.join('; ')}.`
  return base ? `${base} ${checked}` : checked
}

/**
 * Which columns a guarded read may write on its own.
 *
 * Only a "high" read auto-fills, and only into an EMPTY column — a value the
 * trader typed always wins, and a lower-confidence read waits for a click.
 * Measured on the owner's own history before this threshold was picked: high
 * matched the recorded stop exactly on 8 of 10 trades and to within a point on
 * 9; medium missed by as much as 103 points; low was barely better than noise.
 */
export function autoApplicableFields(
  levels: DetectedLevels,
  trade: { stop_price?: number | null; tp1_price?: number | null },
): Partial<{ stop_price: number; tp1_price: number }> {
  if (levels.confidence !== 'high') return {}
  const out: Partial<{ stop_price: number; tp1_price: number }> = {}
  if (levels.stop_price != null && trade.stop_price == null) out.stop_price = levels.stop_price
  if (levels.tp1_price != null && trade.tp1_price == null) out.tp1_price = levels.tp1_price
  return out
}
