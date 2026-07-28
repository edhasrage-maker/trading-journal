'use client'

/**
 * Grade the newest session automatically, right after a first import.
 *
 * The TapeScore is the product's headline number and it only exists once a
 * session has had its end-of-day read. A freshly imported journal therefore
 * shows a blank score at the exact moment it's trying to prove itself, and the
 * trader has no way to know a per-session action is what produces one. So the
 * import flow runs that read once, on their most recent session, and the first
 * dashboard they see has a real score on it.
 *
 * Deliberately reuses the two endpoints the EOD recap already calls rather than
 * re-implementing grading: /api/first-read/autograde hands over the day's data,
 * /api/analyze-eod produces the analysis, /api/trading-days/<date>/eod stores
 * it. One grading path.
 *
 * BEST EFFORT, ALWAYS. Every failure — no eligible session, AI quota spent, a
 * model error — resolves to null and the caller carries on. The dashboard's
 * ungraded state already offers grading as an explicit action, so the floor
 * here is "no worse than before", never a blocked import.
 */

export interface AutoGradeResult {
  /** The session that got graded, YYYY-MM-DD. */
  date: string
  tradeCount: number
}

interface AutoGradePayload {
  date: string | null
  tradeCount?: number
  trades?: unknown[]
  eodNotes?: string
  prepNotes?: unknown
  prepAnalysis?: unknown
  marketContext?: unknown
  sessionEndedAt?: string | null
}

export async function autoGradeLatestSession(): Promise<AutoGradeResult | null> {
  try {
    const payload = await fetch('/api/first-read/autograde')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null) as AutoGradePayload | null
    if (!payload?.date || !Array.isArray(payload.trades) || payload.trades.length === 0) return null

    const res = await fetch('/api/analyze-eod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trades: payload.trades,
        eodNotes: payload.eodNotes ?? '',
        prepNotes: payload.prepNotes,
        prepAnalysis: payload.prepAnalysis,
        marketContext: payload.marketContext,
        imageBase64: null,
        imageMediaType: null,
        sessionEndedAt: payload.sessionEndedAt ?? null,
      }),
    })
    // 429 = the day's AI budget is spent. Not an error worth surfacing here;
    // the trader can still grade any session by hand.
    if (!res.ok) return null
    const analysis = await res.json()
    if (!analysis || analysis.error) return null

    const saved = await fetch(`/api/trading-days/${payload.date}/eod`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eod_ai_analysis_json: analysis }),
    })
    if (!saved.ok) return null

    return { date: payload.date, tradeCount: payload.tradeCount ?? payload.trades.length }
  } catch {
    return null
  }
}
