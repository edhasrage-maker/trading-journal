/**
 * POST /api/recap/commentary — cloud counterpart to /api/video/commentary.
 *
 * The local build reads OBS recordings with ffmpeg. On the hosted app there is
 * no filesystem, so the trader's BROWSER extracts each trade's entry frame
 * (src/lib/browser-frames.ts) and uploads the small JPEGs to their OWN folder in
 * the `screenshots` bucket. This route takes those storage paths, pulls the
 * bytes back server-side, and runs ONE batched multimodal Claude call to produce
 * per-trade commentary + detected levels — then persists to
 * trades.recording_commentary (identical shape to the ffmpeg path) and back-fills
 * a missing screenshot with the entry frame.
 *
 * Body: { videoFile: string, frames: Array<{ id: string, path: string, exitPath?: string }> }
 *   - videoFile: the recording filename (stored on the commentary row so the UI
 *     can flag stale commentary if the user re-runs against a different file).
 *   - frames[].path: `<uid>/recap/<tradeId>-<ts>.jpg` in the `screenshots`
 *     bucket — the ENTRY frame. Server verifies each path is under the caller's
 *     own folder.
 *   - frames[].exitPath (optional): the EXIT frame, same folder rules. When
 *     present it's sent alongside the entry frame (mirrors the ffmpeg path's
 *     entry+exit pair) so the coach can see what price did by the exit.
 *
 * Gating: per-user daily cap (recap_commentary) consumed BEFORE the model call;
 * model tier resolved server-side (Sonnet default, Opus for admin + granted
 * users). The excursion framing fed to the model is INTERPRETED (capture %,
 * $ left, heat vs stop, ×ATR) — never raw point averages, which the model skips.
 *
 * Level detection: the same call reads the planned stop/target off each ENTRY
 * frame (src/lib/frame-levels.ts holds the prompt + the guards, shared with the
 * ffmpeg path). Every read is checked against the trade's REAL fill price and
 * direction before it's trusted; a "high" read then writes straight into
 * trades.stop_price / tp1_price, but ONLY where the column is still empty — a
 * value the trader typed always wins, and anything less certain waits for them
 * to click Apply in the UI. A wrong stop would silently corrupt R and heat.
 *
 * Screenshot back-fill: a trade with no screenshot_url gets its ENTRY frame's
 * storage PATH written as screenshot_url (bare path — the bucket is private +
 * folder-RLS, so the server read boundary signs it; never a public URL, which
 * would 400 on the private bucket). Marked screenshot_source:'obs'.
 */

import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { consumeAiUsage } from '@/lib/ai-usage'
import { resolveAiModel } from '@/lib/ai-model'
import { interpretExcursion } from '@/lib/trade-excursion'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import {
  FRAME_LEVELS_PROMPT_BLOCK, FRAME_LEVELS_SCHEMA, guardFrameLevels, autoApplicableFields,
  type RawFrameLevels,
} from '@/lib/frame-levels'
import type { DetectedLevels } from '@/lib/supabase/types'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface FrameRef { id: string; path: string; exitPath?: string }

// ── Lever C: per-session TIMELINE ──────────────────────────────────────────
// Frames are otherwise scored in ISOLATION, so behavioral patterns (revenge
// re-entries, stacking the same direction, digging into a drawdown) are
// invisible. We rebuild the full day sequence from fills and feed each framed
// trade an interpreted position-in-session line the model can reason over.
interface DayTrade {
  id: string
  trading_day_id: string
  direction: 'long' | 'short' | null
  entry_time: string | null
  exit_time: string | null
  pnl: number | null
}
interface TimelineRow {
  seq: number
  total: number
  /** Nth consecutive trade in the SAME direction (1 = first, or just flipped). */
  consecutiveSameDir: number
  /** Minutes from the PRIOR trade's exit to this entry. Null if not derivable. */
  gapFromPrevExitMin: number | null
  prevOutcome: 'win' | 'loss' | 'flat' | null
  /** Cumulative realized P&L of every trade BEFORE this one in the session. */
  runningPnlBefore: number
}

/** Build the interpreted timeline for one trading day's trades, keyed by id. */
function buildDayTimeline(trades: DayTrade[]): Map<string, TimelineRow> {
  const sorted = [...trades].sort((a, b) => {
    const ta = a.entry_time ? Date.parse(a.entry_time) : Infinity
    const tb = b.entry_time ? Date.parse(b.entry_time) : Infinity
    if (ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const out = new Map<string, TimelineRow>()
  let running = 0
  let prev: DayTrade | null = null
  let consec = 0
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]
    if (prev && t.direction && prev.direction === t.direction) consec++
    else consec = 1
    let gap: number | null = null
    if (prev?.exit_time && t.entry_time) {
      const g = (Date.parse(t.entry_time) - Date.parse(prev.exit_time)) / 60000
      gap = Number.isFinite(g) ? g : null
    }
    const prevOutcome: TimelineRow['prevOutcome'] = prev
      ? (prev.pnl == null ? null : prev.pnl > 0 ? 'win' : prev.pnl < 0 ? 'loss' : 'flat')
      : null
    out.set(t.id, {
      seq: i + 1, total: sorted.length, consecutiveSameDir: consec,
      gapFromPrevExitMin: gap, prevOutcome, runningPnlBefore: running,
    })
    running += t.pnl ?? 0
    prev = t
  }
  return out
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}
function fmtGap(min: number): string {
  if (min < 1) return `${Math.round(min * 60)}s`
  if (min < 60) return `${Math.round(min)}m`
  return `${(min / 60).toFixed(1)}h`
}
function fmtSignedUsd(n: number): string {
  const r = Math.round(n)
  return `${r >= 0 ? '+' : '−'}$${Math.abs(r)}`
}
/** One interpreted line describing this trade's place in the session. */
function timelineLine(tl: TimelineRow, dir: string): string {
  const parts: string[] = [`trade #${tl.seq} of ${tl.total} this session`]
  if (tl.consecutiveSameDir > 1) parts.push(`${ordinal(tl.consecutiveSameDir)} consecutive ${dir.toLowerCase()}`)
  if (tl.gapFromPrevExitMin != null) {
    const outcome = tl.prevOutcome === 'loss' ? ', which LOST'
      : tl.prevOutcome === 'win' ? ', which won'
        : tl.prevOutcome === 'flat' ? ', which scratched' : ''
    parts.push(`entered ${fmtGap(tl.gapFromPrevExitMin)} after the prior exit${outcome}`)
  }
  parts.push(`session P&L before this trade ${fmtSignedUsd(tl.runningPnlBefore)}`)
  let line = parts.join(' · ')
  if (tl.prevOutcome === 'loss' && tl.gapFromPrevExitMin != null && tl.gapFromPrevExitMin < 2) {
    line += ' · ⚠ quick re-entry right after a loss — check for revenge/tilt'
  }
  return line
}

// Order-flow / tape lens is PROFILE-GATED (feedback_no_forced_orderflow):
// price action, structure, location and risk are judged for everyone, but the
// tape read is only invoked when the trader's own profile talks that language.
const OF_HINTS = [
  'order flow', 'orderflow', 'footprint', 'delta', 'absorption', 'aggress',
  'dom', 'tape', 'cvd', 'imbalance', 'bookmap', 'liquidity',
]

const PT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function fmtPT(iso: string | null | undefined): string {
  if (!iso) return '--:--:--'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '--:--:--'
  const parts = PT_TIME_FMT.formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('hour')}:${get('minute')}:${get('second')} PT`
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  let body: { videoFile?: string; frames?: FrameRef[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const videoFile = typeof body.videoFile === 'string' ? body.videoFile : ''
  const frames = Array.isArray(body.frames)
    ? body.frames
        .filter(f => f && typeof f.id === 'string' && typeof f.path === 'string')
        .map(f => ({ id: f.id, path: f.path, exitPath: typeof f.exitPath === 'string' ? f.exitPath : undefined }))
    : []
  if (!videoFile || frames.length === 0) {
    return NextResponse.json({ error: 'videoFile and non-empty frames[] required' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  // Every uploaded frame (entry AND exit) must live under the caller's own
  // storage folder — a client can't ask us to read someone else's object.
  const prefix = `${user.id}/`
  if (frames.some(f => !f.path.startsWith(prefix) || (f.exitPath && !f.exitPath.startsWith(prefix)))) {
    return NextResponse.json({ error: 'frame path outside your storage folder' }, { status: 403 })
  }

  // Per-user daily cap — consume ONE unit per click, before the model call.
  const gate = await consumeAiUsage(supabase, 'recap_commentary')
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  const model = await resolveAiModel(supabase, user)

  // Fetch the real trade rows (RLS-scoped to this user) so the excursion metrics
  // are authoritative, not client-supplied. Only the frames' trade ids.
  const ids = frames.map(f => f.id)
  const { data: tradeRows } = await supabase
    .from('trades')
    .select('id, trading_day_id, direction, entry_price, exit_price, stop_price, tp1_price, quantity, pnl, symbol, entry_time, exit_time, tags_json, notes, screenshot_url, high_during_position, low_during_position, mfe_dollars_per_leg')
    .in('id', ids)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tradesById = new Map<string, any>((tradeRows ?? []).map((t: any) => [t.id, t]))

  // Day-level 1m ATR (per trading_day) → lets us express heat as ×ATR, the
  // interpreted framing the model actually reacts to. Best-effort.
  const dayIds = Array.from(new Set((tradeRows ?? []).map((t: { trading_day_id: string }) => t.trading_day_id).filter(Boolean)))
  const atrByDay = new Map<string, number>()
  if (dayIds.length > 0) {
    const { data: ctxRows } = await supabase
      .from('market_context')
      .select('trading_day_id, atr_1m')
      .in('trading_day_id', dayIds)
    for (const c of (ctxRows ?? []) as Array<{ trading_day_id: string; atr_1m: number | null }>) {
      if (c.atr_1m != null && c.atr_1m > 0) atrByDay.set(c.trading_day_id, c.atr_1m)
    }
  }

  // Full day sequence (ALL trades, not just the framed ones) so the timeline's
  // running P&L, consecutive-direction counts and re-entry gaps are correct.
  const timelineById = new Map<string, TimelineRow>()
  if (dayIds.length > 0) {
    const { data: dayTradeRows } = await supabase
      .from('trades')
      .select('id, trading_day_id, direction, entry_time, exit_time, pnl')
      .in('trading_day_id', dayIds)
    const byDay = new Map<string, DayTrade[]>()
    for (const r of (dayTradeRows ?? []) as DayTrade[]) {
      const arr = byDay.get(r.trading_day_id)
      if (arr) arr.push(r)
      else byDay.set(r.trading_day_id, [r])
    }
    for (const rows of byDay.values()) {
      for (const [id, row] of buildDayTimeline(rows)) timelineById.set(id, row)
    }
  }

  // Trader profile — the master switch (lever A). RLS-scoped: getTraderProfile
  // reads the caller's OWN id='default' row, so on the multi-tenant cloud each
  // user gets their own standing context. Empty string when unset.
  const traderProfile = await getTraderProfile()
  const usesOrderFlow = OF_HINTS.some(h => traderProfile.preferences_md.toLowerCase().includes(h))

  // Mistake library — constrain the AI's suggestions to the trader's taxonomy.
  const { data: mistakeRows } = await supabase
    .from('trade_tags').select('label').eq('category', 'mistakes').order('sort_order') as { data: { label: string }[] | null }
  const mistakeLibrary = (mistakeRows ?? []).map(r => r.label)

  const mediaType = normalizeAnthropicMediaType('image/jpeg')!
  const blocks: Anthropic.MessageParam['content'] = []
  const labels: string[] = []
  const descriptions: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  // Entry frames adopted as the trade's screenshot when it had none — id → the
  // frame's bare storage PATH (NOT a public URL; the bucket is private + folder-
  // RLS, so the read boundary signs it). Best-effort back-fill.
  const backfillScreenshot: Record<string, string> = {}

  // Pull a stored object back as base64 (RLS-scoped to the user's folder). Null
  // on any failure so callers can skip just that frame.
  const downloadB64 = async (path: string): Promise<string | null> => {
    try {
      const { data: blob, error } = await supabase.storage.from('screenshots').download(path)
      if (error || !blob) return null
      return Buffer.from(await blob.arrayBuffer()).toString('base64')
    } catch {
      return null
    }
  }

  let idx = 0
  for (const f of frames) {
    const t = tradesById.get(f.id)
    if (!t) { skipped.push({ id: f.id, reason: 'trade not found' }); continue }

    // Pull the ENTRY frame bytes back from storage.
    const dataB64 = await downloadB64(f.path)
    if (dataB64 == null) { skipped.push({ id: f.id, reason: 'frame download failed' }); continue }

    idx++
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } })
    labels.push(`Trade ${idx} (id=${f.id}) ENTRY @ ${fmtPT(t.entry_time)}`)

    // EXIT frame, when the client uploaded one (exit meaningfully after entry &
    // in range — the client already gated that). Same trade number in the label
    // so the model pairs them. A failed exit download drops only the exit frame.
    if (f.exitPath) {
      const exitB64 = await downloadB64(f.exitPath)
      if (exitB64 != null) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: exitB64 } })
        labels.push(`Trade ${idx} (id=${f.id}) EXIT @ ${fmtPT(t.exit_time)}`)
      }
    }

    // Back-fill a missing screenshot with the entry frame's storage path. Never
    // overwrite a manual capture.
    if (!t.screenshot_url) backfillScreenshot[f.id] = f.path

    // ── INTERPRETED excursion framing (capture %, $ left, heat vs stop, ×ATR) ──
    const exc = interpretExcursion(t)
    const atr = atrByDay.get(t.trading_day_id)
    const excParts: string[] = []
    if (exc.r != null) excParts.push(`realized ${exc.r.toFixed(2)}R`)
    if (exc.capPct != null) excParts.push(`captured ${Math.round(exc.capPct * 100)}% of the favorable move`)
    if (exc.leftUsd != null && exc.leftUsd > 0) excParts.push(`left $${Math.round(exc.leftUsd)} on the table`)
    if (exc.mfeR != null) excParts.push(`peak favorable run ${exc.mfeR.toFixed(1)}R`)
    if (exc.maePct != null) excParts.push(`took ${Math.round(exc.maePct * 100)}% of the planned stop in heat`)
    else if (exc.maePts != null) excParts.push(`took ${exc.maePts.toFixed(1)} pts of heat`)
    if (atr && exc.maePts != null) excParts.push(`(${(exc.maePts / atr).toFixed(1)}× the day's 1m ATR)`)
    const excLine = excParts.length ? excParts.join(' · ') : 'no MFE/MAE data on this trade'

    const dir = t.direction?.toUpperCase() ?? '—'
    const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'
    const setups = (t.tags_json?.setups as string[] | undefined)?.join(', ') || '—'
    const orderFlow = (t.tags_json?.order_flow as string[] | undefined)?.join(', ') || '—'
    const mistakes = (t.tags_json?.mistakes as string[] | undefined)?.join(', ') || '—'
    const notes = t.notes?.trim() ? `\n  notes (their words): ${t.notes.trim()}` : ''
    const tl = timelineById.get(f.id)
    const timeline = tl ? `\n  session: ${timelineLine(tl, dir)}` : ''
    descriptions.push(`Trade ${idx} (id=${f.id}): ${dir} ${t.quantity ?? '?'} @ ${t.entry_price ?? '?'} → ${t.exit_price ?? '?'} | PnL ${pnl}
  trader's OWN labels (their claim — verify against the frame, don't just repeat): setups ${setups} | order_flow ${orderFlow} | mistakes ${mistakes}
  exit/heat (interpreted): ${excLine}${timeline}${notes}`)
  }

  if (blocks.length === 0) {
    return NextResponse.json({
      commentary: {}, skipped, framesUsed: 0, model,
      note: 'No frames could be read — every upload failed or its trade was missing.',
    })
  }

  const mistakeListBlock = mistakeLibrary.length > 0
    ? `\n\nAvailable mistake tags (suggest 0–3 per trade, ONLY from this list — copy labels verbatim, do not invent new ones; pick ONLY mistakes clearly visible in the frame, not speculative):\n${mistakeLibrary.map(m => `  - ${m}`).join('\n')}`
    : ''

  // Lever D — order-flow lens is gated on the profile; PA/structure/location/
  // risk are always judged (feedback_no_forced_orderflow).
  const orderFlowClause = usesOrderFlow
    ? `Because this trader's profile uses order flow, ALSO read the tape where it's visible on the frame — footprint/delta, absorption, who's aggressing — and factor it into the read. Do NOT assume a DOM/depth ladder is on the chart unless one is clearly visible.`
    : `This trader does NOT trade order flow — judge purely on price action, market structure, location and risk. Do NOT fault them for any missing order-flow/tape confirmation or invoke a lens their profile doesn't use.`

  const prompt = profileContextBlock(traderProfile) + `You are an objective trading coach reviewing screen-recording frames from a futures trader's session. Each frame is the trader's actual chart at a precise moment — an ENTRY frame (when they pulled the trigger) and, when present, an EXIT frame (when they closed).

Your job is an INDEPENDENT read, NOT a summary of what the trader already told you. Under each trade you'll see the trader's OWN labels (setups, tags) and their P&L — treat those as CLAIMS to verify, never as facts to restate. Read the chart yourself and be willing to DISAGREE: if the frame doesn't support the tagged setup, or structure/location argues against the entry, say so plainly. Do not parrot the P&L or the tags back — the trader already knows those; your value is the read they can't get from their own notes.

For each trade you see frames of, do TWO things:

1) Write 1–3 sentences of HONEST, INDEPENDENT commentary. LEAD with what you actually see on the chart — market structure (higher-highs/higher-lows vs lower-highs/lower-lows, break vs reclaim), where price sits relative to key levels / session levels / range extremes, and whether the entry is WITH or AGAINST the prevailing move. Then weigh the risk using the interpreted exit/heat line (it is already computed for you: capture % of the favorable move, $ left on the table, heat taken as a share of the planned stop / ×ATR) — if a trade captured little of a large favorable move, or took most of its stop in heat before working, SAY SO. ${orderFlowClause} If an EXIT frame is present and price did something obvious between entry and exit that the trader missed (ran further, reversed at a level), point it out. Use the per-trade session line to catch BEHAVIORAL patterns the isolated chart can't show — a quick re-entry right after a loss (possible revenge/tilt), the Nth consecutive trade in the same direction, or pressing deeper into a drawdown — and name it when the sequence shows it.

2) ${FRAME_LEVELS_PROMPT_BLOCK}${mistakeListBlock}

The image array above is ordered as follows:
${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Trade context (matches the image labels by trade id):
${descriptions.join('\n')}

Return ONE entry in the trades array per unique trade id (use the id strings exactly as shown). suggested_mistakes is required but may be empty. detected_levels is required — set all four price fields to null if no working orders were visible.`

  blocks.push({ type: 'text', text: prompt })

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 6000,
      messages: [{ role: 'user', content: blocks }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              trades: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    commentary: { type: 'string' },
                    suggested_mistakes: { type: 'array', items: { type: 'string' } },
                    detected_levels: FRAME_LEVELS_SCHEMA,
                  },
                  required: ['id', 'commentary', 'suggested_mistakes', 'detected_levels'],
                  additionalProperties: false,
                },
              },
            },
            required: ['trades'],
            additionalProperties: false,
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!text) {
      return NextResponse.json({ commentary: {}, suggested_mistakes: {}, skipped, framesUsed: blocks.length - 1, model, note: 'AI returned no text content.' })
    }

    let parsed: { trades?: Array<{ id?: string; commentary?: string; suggested_mistakes?: string[]; detected_levels?: RawFrameLevels }> }
    try { parsed = JSON.parse(text) }
    catch (parseErr) {
      console.error('[recap/commentary] JSON parse failed:', parseErr, '\nraw:', text.slice(0, 500))
      return NextResponse.json({ commentary: {}, suggested_mistakes: {}, detected_levels: {}, skipped, framesUsed: blocks.length - 1, model, note: 'Structured-output JSON failed to parse.' })
    }

    const commentary: Record<string, string> = {}
    const suggested: Record<string, string[]> = {}
    const detectedLevels: Record<string, DetectedLevels> = {}
    // Columns the read filled by itself — only ever a "high" read into an empty
    // column (see autoApplicableFields). Returned so the UI can say so out loud
    // instead of the number just appearing.
    const autoApplied: Record<string, Partial<{ stop_price: number; tp1_price: number }>> = {}
    if (Array.isArray(parsed.trades)) {
      const librarySet = new Set(mistakeLibrary)
      for (const t of parsed.trades) {
        if (typeof t?.id !== 'string' || typeof t?.commentary !== 'string') continue
        commentary[t.id] = t.commentary
        if (Array.isArray(t.suggested_mistakes)) {
          const valid = t.suggested_mistakes.filter(s => typeof s === 'string' && librarySet.has(s))
          if (valid.length > 0) suggested[t.id] = valid
        }
        // Check the read against the trade's ACTUAL fill and direction before it
        // goes anywhere near a column — a wrong stop silently corrupts R and heat.
        const row = tradesById.get(t.id)
        const guarded = guardFrameLevels(t.detected_levels, row ?? {})
        if (guarded) {
          detectedLevels[t.id] = guarded.levels
          if (row) {
            const fields = autoApplicableFields(guarded.levels, row)
            if (Object.keys(fields).length > 0) autoApplied[t.id] = fields
          }
        }
      }
    }

    // Persist per-trade commentary (same shape as the ffmpeg path) so it
    // survives reload + syncs across devices. Silent-fail on a missing column so
    // the AI text still returns. Also back-fills screenshot_url with the entry
    // frame's storage PATH for trades that had none — adopting the storage-
    // hardening track's path-store format (bare path; the read boundary signs
    // it) rather than a public URL, which would 400 against the private bucket.
    try {
      const generatedAt = new Date().toISOString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const writes: Array<Promise<any>> = Object.entries(commentary).map(([id, textOut]) => {
        const applied = autoApplied[id]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const update: Record<string, any> = {
          recording_commentary: {
            text: textOut,
            video_file: videoFile,
            model,
            generated_at: generatedAt,
            detected_levels: detectedLevels[id],
            ...(applied ? { auto_applied: Object.keys(applied) } : {}),
            ...(backfillScreenshot[id] ? { screenshot_source: 'obs' } : {}),
          },
        }
        if (backfillScreenshot[id]) update.screenshot_url = backfillScreenshot[id]
        // A confidently-read level lands in the column in the same write as the
        // commentary — that's the whole point of reading the frame.
        if (applied) Object.assign(update, applied)
        return supabase.from('trades').update(update).eq('id', id)
      })
      // A back-filled trade that got no commentary text still needs its
      // screenshot_url written (rare — frame read but the model skipped that id).
      for (const [id, path] of Object.entries(backfillScreenshot)) {
        if (!commentary[id]) writes.push(supabase.from('trades').update({ screenshot_url: path }).eq('id', id))
      }
      const results = await Promise.allSettled(writes)
      const firstReject = results.find(r => r.status === 'rejected')
      if (firstReject && firstReject.status === 'rejected') console.warn('[recap/commentary] persistence skipped:', firstReject.reason)
    } catch (persistErr) {
      console.warn('[recap/commentary] persistence skipped:', persistErr)
    }

    return NextResponse.json({
      commentary,
      suggested_mistakes: suggested,
      detected_levels: detectedLevels,
      auto_applied: autoApplied,
      auto_screenshots: backfillScreenshot,
      skipped,
      framesUsed: blocks.length - 1,
      model,
    })
  } catch (e) {
    const err = e as { message?: string; error?: { message?: string }; status?: number }
    console.error('[recap/commentary] failed:', err)
    return NextResponse.json({ error: err?.error?.message ?? err?.message ?? 'commentary failed' }, { status: err?.status ?? 500 })
  }
}
