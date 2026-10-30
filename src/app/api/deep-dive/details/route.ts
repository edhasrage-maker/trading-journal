import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { resolveScreenshotUrls } from '@/lib/storage-url'
import { ruleLabel, ruleMistakeTag } from '@/lib/entry-rules'
import { runnerMistakeTag, runnerRuleLabel } from '@/lib/runner-rules'
import { loadTapeScoreSettings } from '@/lib/day-stats-server'
import { getGiveBackAtr } from '@/lib/atr-config-server'
import { tradeGrade, type TradeGrade } from '@/lib/trade-grade'
import { reentryReads } from '@/lib/tapescore-day-rules'
import { tradeMgmt } from '@/lib/trade-management'
import { plannedStopPrice } from '@/lib/planned-stop'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { TAPE_KEEP_DAYS } from '@/lib/orderflow/tape'
import { entryCtxIsCurrent, flowScoreIsCurrent } from '@/lib/orderflow/flow-score-meta'
import { coachTagsOn } from '@/lib/coach-tag-audit-server'
import type { CoachTagInfo } from '@/lib/coach-tag-audit'

export const dynamic = 'force-dynamic'

export interface ReplayDetails {
  tradeId: string
  /** Signed screenshot URL, or null when the trade has none. */
  screenshot: string | null
  /** tags_json as stored. The panel edits its groups and sends it back whole, every other key kept (day_type, custom groups). */
  tagsJson: Record<string, unknown>
  /** The mistake tags your rules put on (review_json.auto_tags) → the name of the rule ('' if it's no longer on). */
  ruleTags: Record<string, string>
  /** The coach's tags still on the trade, `category|label` → how sure, why, already kept (src/lib/coach-tag-audit.ts). */
  coachTags: Record<string, CoachTagInfo>
  /** The trade's Score (Entry + Exit), exactly as the Recap's Score column works it out. */
  grade: TradeGrade
  /** For the Exit lines: the trade never got 1×ATR its way; a stop was logged. */
  neverWent: boolean
  hasStop: boolean
  /** Its Entry inputs (the tick read at the fill) are missing or stale and can still be read: score it now. */
  needsScore: boolean
  /** Its Entry inputs are missing and this site can't read them: older than the tick data it keeps. */
  tooOld: boolean
}

const UUID = /^[0-9a-f-]{36}$/i

/**
 * GET /api/deep-dive/details?id=<trade uuid>  → ReplayDetails
 *
 * Replay Review's "Your trade" panel: the trade's Score, screenshot and tags.
 * All three can give the result away (the Exit half is how it went; a live
 * Sierra screenshot shows the open P&L; a Mistake tag says how it went), so
 * the workspace asks for this only in Full review, never in Blind.
 *
 * The Score is the Recap's (tradeGrade with the trader's own rules and
 * settings). When its Entry inputs were never read, `needsScore` tells the
 * panel to run POST /api/trades/score for this one trade and ask again.
 * Same private beta as the page; RLS scopes the row.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  if (!deepDiveAllowed(user.email)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!UUID.test(id)) return NextResponse.json({ error: 'id=<trade uuid> required' }, { status: 400 })

  const [{ data: row, error }, settings, giveBackAtr] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the whole row: the grade reads many columns + review_json
    (supabase as any).from('trades').select('*').eq('id', id).maybeSingle(),
    loadTapeScoreSettings(supabase),
    getGiveBackAtr(supabase),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'trade not found' }, { status: 404 })

  // A quick re-entry after a loss gets "Waited after a loss": read over its day's trades, as the Recap does.
  const { data: dayRows } = row.trading_day_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the columns reentryReads needs
    ? await (supabase as any).from('trades')
      .select('id, entry_time, exit_time, pnl, direction, entry_price, exit_price, stop_price, tp1_price, quantity, symbol, high_during_position, low_during_position, exits_json, tags_json, stops:review_json->stops')
      .eq('trading_day_id', row.trading_day_id)
    : { data: null }
  const grade = tradeGrade(row, {
    entryRules: settings.entryRules, runnerRules: settings.runnerRules,
    includeFlow: settings.includeFlow, atrStopTarget: settings.atrStopTarget,
    reentry: dayRows ? reentryReads(dayRows).get(row.id) ?? null : null,
  })

  // Same test the Recap's on-demand scoring uses (use-flow-scores.ts): an NQ / ES
  // trade with a fill, whose snapshot (and order-flow Score, when it counts) isn't
  // this version's read of this fill. The site's tape goes back 90 days; the
  // local build reads Sierra's own files, which have no such limit.
  const root = row.symbol ? chartSeriesRoot(row.symbol) : ''
  const at = Date.parse(row.entry_time ?? '')
  const readable = (root === 'NQ' || root === 'ES') && (row.direction === 'long' || row.direction === 'short')
    && row.entry_price != null && Number.isFinite(at)
  const rj = row.review_json ?? {}
  const missing = !entryCtxIsCurrent(rj.entry_ctx, row) || (settings.includeFlow && !flowScoreIsCurrent(rj.score, row))
  const inTape = LOCAL_FEATURES_ENABLED || Date.now() - at < TAPE_KEEP_DAYS * 86_400_000

  // which rule put each app-added mistake tag on (the rule-tags pass names tags after the rule's fail)
  const ruleOf = new Map<string, string>()
  for (const r of settings.entryRules) if (r.on) { const t = ruleMistakeTag(r); if (!ruleOf.has(t)) ruleOf.set(t, ruleLabel(r)) }
  for (const r of settings.runnerRules) if (r.on) { const t = runnerMistakeTag(r); if (t && !ruleOf.has(t)) ruleOf.set(t, runnerRuleLabel(r)) }
  const auto = Array.isArray(rj.auto_tags) ? (rj.auto_tags as unknown[]).filter((t): t is string => typeof t === 'string') : []
  const tj = row.tags_json

  const [screenshot] = await resolveScreenshotUrls(supabase, [row.screenshot_url])
  let coachTags: Record<string, CoachTagInfo> = {}
  try { coachTags = await coachTagsOn(supabase, row.id) } catch (e) { console.error('[deep-dive/details] coach tags', e) }
  const out: ReplayDetails = {
    tradeId: row.id,
    screenshot: screenshot ?? null,
    tagsJson: tj && typeof tj === 'object' && !Array.isArray(tj) ? tj : {},
    ruleTags: Object.fromEntries(auto.map(t => [t, ruleOf.get(t) ?? ''])),
    coachTags,
    grade,
    neverWent: tradeMgmt(row, { thresholdAtr: giveBackAtr })?.went === false,
    hasStop: plannedStopPrice(row) != null,
    needsScore: readable && missing && inTape,
    tooOld: readable && missing && !inTape,
  }
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
