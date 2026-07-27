/**
 * Post-exit verdict — plain-language read on the EXIT decision, judged by what
 * the market did in the 30 minutes after you were out (PostExitData). This is
 * the row-level face of "we grade your decisions, not your P&L".
 *
 * Spec: docs/post-exit-verdict-spec.md. Post-exit continuation is judged FIRST;
 * the intra-trade "gave it back" label is only the fallback for a loser whose
 * post-exit window was flat (give-backs are already flagged by the bold capture
 * chip elsewhere in the row).
 */
import type { PostExitData } from '@/lib/atr'
import { isGiveBackTrade, mfeMaePoints, type TradeWithExcursion } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'

export type VerdictTone = 'good' | 'welltimed' | 'left' | 'giveback' | 'flat'

export interface PostExitVerdict {
  glyph: string
  tone: VerdictTone
  /** Short chip copy, e.g. "exit right — dropped 9pts after". */
  label: string
  /** Longer hover explanation. */
  title: string
}

/** Fields the verdict needs. Extends the analytics excursion shape (so
 *  isGiveBackTrade/mfeMaePoints accept it directly) plus exit_price + the stored
 *  entry ATR. A full EOD Trade row satisfies this structurally. */
export type VerdictTrade = TradeWithExcursion & {
  exit_price?: number | null
  entry_atr_1m?: number | null
}

/**
 * "Was the post-exit move big enough to matter", in points.
 *
 * ATR-FIRST, deliberately. This used to lead with 0.5R, which made materiality a
 * property of the trader's STOP rather than of the market: a live trade with a
 * 0.58×ATR stop got a 10-pt bar where a normal stop gives ~36, so the same
 * market wiggle read as "you left money" for the tight-stop trader and "flat
 * after" for everyone else — for identical market behaviour.
 *
 * R survives as the fallback for rows with no stored ATR; a flat 3 points is the
 * last resort.
 */
function materialThresholdPts(riskPts: number | null, atr: number | null): number {
  if (atr != null && atr > 0) return atr
  if (riskPts != null && riskPts > 0) return riskPts * 0.5
  return 3
}

/**
 * Compute the verdict, or null when there's no post-exit data to judge (the
 * caller shows an em-dash). Pure — no bars/network needed.
 */
export function postExitVerdict(t: VerdictTrade, ext: PostExitData | null | undefined): PostExitVerdict | null {
  if (!ext) return null

  const isLong = t.direction === 'long'
  const cont = ext.continued_favorable_pts       // further move in your direction after exit
  const against = ext.continued_against_pts       // reversal against your direction after exit

  const capturedPts = (t.entry_price != null && t.exit_price != null)
    ? (isLong ? t.exit_price - t.entry_price : t.entry_price - t.exit_price)
    : null
  const win = t.pnl != null ? t.pnl > 0 : (capturedPts != null ? capturedPts > 0 : false)

  const riskPts = (t.entry_price != null && t.stop_price != null)
    ? Math.abs(t.entry_price - t.stop_price)
    : null
  const atr = t.entry_atr_1m != null && t.entry_atr_1m > 0 ? t.entry_atr_1m : null
  const thresh = materialThresholdPts(riskPts, atr)
  const contMat = cont >= thresh
  const againstMat = against >= thresh

  // Display magnitude: ×ATR first, R only as a fallback, then whole points.
  //
  // What happened AFTER the exit is a fact about the market, not about the
  // trader's risk, so R distorts it: two live trades minutes apart read 8.7R and
  // 3.3R purely because the first had a tighter stop — 5.0×ATR and 2.4×ATR is
  // the honest comparison. The dollar figure alongside already answers "what did
  // it cost me", which frees the normalized unit to describe the move. R stays
  // where it belongs — the trade's own outcome, and the give-back read below.
  const toR = (pts: number): number | null => (riskPts != null && riskPts > 0 ? pts / riskPts : null)
  const mag = (pts: number): string => {
    if (atr != null) return `${(pts / atr).toFixed(1)}×ATR`
    const r = toR(pts)
    return r != null ? `${r.toFixed(1)}R` : `${Math.round(pts)}pts`
  }
  const partialNote = ext.full_window ? '' : ' (partial window — bars ran out)'

  // A "confident" vindication (exit-right / stop-right) needs either a full
  // window or a clearly-large move — twice the materiality bar. On a partial
  // window with only a marginal move, downgrade to flat so we don't over-claim.
  const confident = (pts: number): boolean => ext.full_window || pts >= 2 * thresh

  if (win) {
    if (contMat && cont >= against) {
      const mult = symbolToMultiplier(t.symbol ?? '')
      const usd = (t.quantity != null && mult > 0) ? Math.round(cont * t.quantity * mult) : null
      const dollars = usd != null && usd > 0 ? ` (~$${usd.toLocaleString()})` : ''
      return {
        glyph: '◐', tone: 'left',
        label: `early — left ${mag(cont)}${dollars}`,
        title: `The market ran ${cont.toFixed(1)} pts further in your direction in the 30 min after you exited — you left ${mag(cont)}${dollars} on the table.${partialNote}`,
      }
    }
    if (againstMat && confident(against)) {
      const verb = isLong ? 'dropped' : 'rallied'
      return {
        glyph: '✓', tone: 'good',
        label: `exit right — ${verb} ${Math.round(against)}pts after`,
        title: `You locked it in: the market ${verb} ${against.toFixed(1)} pts against your direction in the 30 min after exit.${partialNote}`,
      }
    }
    return {
      glyph: '✓', tone: 'welltimed',
      label: 'well-timed — flat after',
      title: `Clean exit — the market went essentially nowhere in the 30 min after you were out.${partialNote}`,
    }
  }

  // Loser
  if (againstMat && against >= cont && confident(against)) {
    const verb = isLong ? 'falling' : 'rising'
    return {
      glyph: '✓', tone: 'good',
      label: `stop right — kept ${verb} ${Math.round(against)}pts`,
      title: `Getting out was correct: the idea stayed invalidated and the market kept ${verb} ${against.toFixed(1)} pts in the 30 min after exit.${partialNote}`,
    }
  }
  if (contMat) {
    return {
      glyph: '◐', tone: 'left',
      label: `early — recovered ${Math.round(cont)}pts after`,
      title: `The market recovered ${cont.toFixed(1)} pts back in your direction in the 30 min after you exited — the exit may have been early.${partialNote}`,
    }
  }
  // Flat after a loss — fall back to the intra-trade give-back read.
  if (isGiveBackTrade(t)) {
    const xc = mfeMaePoints(t)
    const mfeR = xc && riskPts != null && riskPts > 0 ? (xc.mfe / riskPts) : null
    return {
      glyph: '✗', tone: 'giveback',
      label: mfeR != null ? `gave it back — had +${mfeR.toFixed(1)}R, closed red` : 'gave it back — closed red',
      title: `You reached ${mfeR != null ? `+${mfeR.toFixed(1)}R` : 'a real winner'} in favor before this trade reversed to a loss; the market was flat after exit.${partialNote}`,
    }
  }
  return {
    glyph: '·', tone: 'flat',
    label: 'flat after',
    title: `The market went essentially nowhere in the 30 min after exit.${partialNote}`,
  }
}
