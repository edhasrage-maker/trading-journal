import type { Trade, EodAiAnalysis } from '@/lib/supabase/types'
import { parseEodResponse, applyDeterministicOverrides } from '@/lib/eod-prompt'
import type { RailConfig } from '@/lib/scoring-profile'
import { profileContextBlock, type TraderProfile } from '@/lib/trader-profile'
import { behavioralProxiesPromptBlock } from '@/lib/behavioral-proxies'
import { fetchJournalEntries, journalLanguageHeatmapPromptBlock } from '@/lib/journal-language-heatmap'
import { fetchOpenThread, coachingThreadPromptBlock } from '@/lib/coaching-thread'
import { computeSessionFacts } from '@/lib/session-facts'
import { computeTraderBaselines, baselinesPromptBlock, type DayConditions } from '@/lib/trader-baselines'
import { checkFactClaims, checkPraiseContradictions } from '@/lib/ai-constraints'

/**
 * The context an end-of-day analysis is built on, and the post-processing its
 * output goes through — shared by /api/analyze-eod and the batch re-analysis
 * script.
 *
 * This lived inline in the route, which is how the batch script ended up
 * rebuilding a different prompt: it called buildEodPrompt alone, so a batch run
 * silently dropped the trader profile, behavioural signals, journal language,
 * coaching thread and the baselines block (the "what the tape adds" citations),
 * graded against default rails instead of the trader's own, and skipped the
 * trust-layer fact check. Re-analysing a day through it made the day worse.
 * With both paths calling these two functions, they cannot drift apart again.
 *
 * Takes an explicit Supabase client. The route passes its RLS-scoped cookie
 * client; a script must pass a client scoped to ONE user, because every reader
 * here assumes RLS and a bare service-role client would pull other accounts'
 * journals, threads and trades into the prompt.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export interface EodContext {
  /** Prepended ahead of buildEodPrompt's output. */
  head: string
  /** Passed INTO buildEodPrompt, which places it. */
  baselinesBlock: string
}

export async function buildEodContext(
  sb: AnyClient,
  opts: { trades: Trade[]; sessionEndedAt?: string | null; traderProfile: TraderProfile },
): Promise<EodContext> {
  const { trades, sessionEndedAt, traderProfile } = opts

  // Journal language heatmap (Pt 3) — recurring words/phrases + emotional
  // language mined from the trader's OWN free text. A heatmap is about
  // RECURRENCE, so mine a trailing ~90-day window (not just today) and let the
  // EOD read react to language patterns. Best-effort: any failure — or no date
  // anchor (no trades) — yields an empty block that adds no prompt weight.
  let journalBlock = ''
  try {
    const anchor = latestTradeDate(trades)
    if (anchor) {
      const entries = await fetchJournalEntries(sb, { startDate: minusDays(anchor, 90), endDate: anchor })
      journalBlock = journalLanguageHeatmapPromptBlock(entries)
    }
  } catch (e) {
    console.warn('[eod-context] journal heatmap skipped:', e)
  }

  // Coaching thread (Pt 4) — the coach's prior directives + the trader's
  // commitments, READ as context. Does NOT update thread status (the
  // distiller owns that). Best-effort: empty until the table exists.
  let coachingBlock = ''
  try {
    coachingBlock = coachingThreadPromptBlock(await fetchOpenThread(sb))
    if (coachingBlock) coachingBlock = '\n\n' + coachingBlock + '\n'
  } catch (e) {
    console.warn('[eod-context] coaching thread skipped:', e)
  }

  // The trader's own historical baselines — how each tag / heat band has
  // actually performed across their book. Without these the analysis could only
  // describe the tags it was handed. Best-effort: none means no citations.
  let baselinesBlock = ''
  try {
    const { data: book } = await sb
      .from('trades')
      .select('id, trading_day_id, pnl, entry_price, stop_price, tp1_price, exit_price, quantity, direction, symbol, tags_json, high_during_position, low_during_position')
      .not('stop_price', 'is', null)
      .order('entry_time', { ascending: false })
      .limit(400) as { data: Parameters<typeof computeTraderBaselines>[0] | null }
    if (book && book.length > 0) {
      // Day-level conditions for the same window, so the baselines can answer
      // "was today a market I do well in" — not just "how was the excursion".
      const dayIds = Array.from(new Set(book.map(t => t.trading_day_id).filter((v): v is string => !!v)))
      const conditions = new Map<string, DayConditions>()
      if (dayIds.length > 0) {
        const [dayRes, ctxRes] = await Promise.all([
          sb.from('trading_days').select('id, day_types').in('id', dayIds),
          sb.from('market_context').select('trading_day_id, rvol, adr, day_range, ib_regime').in('trading_day_id', dayIds),
        ])
        const ctxByDay = new Map(
          ((ctxRes.data ?? []) as Array<{ trading_day_id: string; rvol: number | null; adr: number | null; day_range: number | null; ib_regime: string | null }>)
            .map(c => [c.trading_day_id, c]),
        )
        for (const d of (dayRes.data ?? []) as Array<{ id: string; day_types: string[] | null }>) {
          const c = ctxByDay.get(d.id)
          conditions.set(d.id, {
            dayTypes: Array.isArray(d.day_types) ? d.day_types : [],
            rvol: c?.rvol ?? null,
            rangeUsedPct: c?.adr && c.day_range != null && c.adr > 0 ? (c.day_range / c.adr) * 100 : null,
            ibRegime: c?.ib_regime ?? null,
          })
        }
      }
      baselinesBlock = baselinesPromptBlock(computeTraderBaselines(book, conditions))
    }
  } catch (e) {
    console.warn('[eod-context] baselines skipped:', e instanceof Error ? e.message : 'unknown')
  }

  const head = profileContextBlock(traderProfile)
    + behavioralProxiesPromptBlock(trades, sessionEndedAt)
    + journalBlock
    + coachingBlock

  return { head, baselinesBlock }
}

/**
 * Parse the model's reply and apply everything the route applies after it:
 * the deterministic overrides (P1-P5 rules, verdict re-derive, profit factor,
 * MFE capture, MAE heat, composite) and the trust-layer annotation.
 */
export function finalizeEodAnalysis(
  text: string,
  trades: Trade[],
  rc: RailConfig,
  log: (msg: string) => void = () => {},
): EodAiAnalysis {
  const parsed = parseEodResponse(text)
  applyDeterministicOverrides(parsed, trades, log, rc)

  // Trust-layer annotation (A9 + A10) — grade the model's NUMERIC claims
  // against the deterministic session facts, and its praise against the
  // trader's own mistake tags. Annotate-and-log only, NEVER block: a false
  // positive must not cost a session, so violations ride on the saved analysis
  // (fact_check) for the UI and audit. Run on the raw model text so evidence
  // quotes match what was written.
  try {
    const facts = computeSessionFacts(trades)
    const mistakesByTrade = trades.map(t => {
      const arr = (t.tags_json as { mistakes?: unknown } | null)?.mistakes
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    })
    const violations = [
      ...checkFactClaims(text, facts),
      ...checkPraiseContradictions(parsed.what_worked, mistakesByTrade),
    ]
    if (violations.length > 0) {
      parsed.fact_check = { checked_at: new Date().toISOString(), violations }
      log(`trust-layer: ${violations.length} violation(s) — ` + violations.map(v => `${v.id}: ${v.message}`).join(' | '))
    }
  } catch (e) {
    log(`trust-layer check skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parsed
}

/** PT (America/Los_Angeles) YYYY-MM-DD of the most recent fill — the window
 *  anchor for the trailing journal heatmap. null when no trade has an entry_time. */
function latestTradeDate(trades: Trade[]): string | null {
  let max: number | null = null
  for (const t of trades) {
    const et = t.entry_time ? Date.parse(t.entry_time) : NaN
    if (Number.isFinite(et)) max = max == null ? et : Math.max(max, et)
  }
  if (max == null) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(max))
}

/** Subtract n days from a YYYY-MM-DD string (UTC-noon anchored to dodge DST). */
function minusDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
