/**
 * POST /api/coach
 * Body: { message: string, history: Array<{ role: 'user'|'assistant', content: string }> }
 *
 * Streams a Claude response back. Context Claude gets per call:
 *   - Trader profile (standing coaching preferences from /settings/coaching)
 *   - Pre-aggregated session stats (last 180 days): win rate, total PnL,
 *     top setups by R-multiple, top mistakes by frequency, day-type
 *     performance, current week vs prior week deltas
 *   - Last 50 trades summarized (date, side, qty, pnl, R, key tags)
 *   - The user's chat history (so the conversation is coherent)
 *
 * Why pre-aggregate vs let Claude run SQL: pre-aggregating is dramatically
 * simpler to ship and gives the model dense, query-tested context. Tool-use
 * SQL could come later if specific questions need it; not v1.
 *
 * Streaming: SSE-shaped — each chunk is `data: {"text": "..."}\n\n` followed
 * by `data: [DONE]\n\n` to signal end. Client uses fetch + ReadableStream.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface CoachBody {
  message: string
  history?: ChatMessage[]
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })
  }

  let body: CoachBody
  try { body = await req.json() }
  catch { return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 }) }

  if (!body.message || typeof body.message !== 'string') {
    return new Response(JSON.stringify({ error: 'message required' }), { status: 400 })
  }

  const supabase: AnyClient = await createClient()

  // Build the coach context block. Done in a separate file so it can be
  // unit-tested and so the route stays focused on streaming.
  const contextBlock = await buildCoachContext(supabase)
  const traderProfile = await getTraderProfile()

  const systemPrompt = `${profileContextBlock(traderProfile)}You are the trader's personal coach, embedded in their trading journal app. You have access to their trading history (summarized below). Your job: answer their questions directly using their actual data. Be SPECIFIC — cite trade counts, dates, PnL figures, win rates, tag names. Don't give generic trading advice; reference what THIS trader has actually done.

When the data doesn't support a confident answer, say so explicitly ("I don't have enough trades in this bucket to call it") rather than guessing. When the trader's coaching preferences (above) conflict with what generic advice would suggest, ALWAYS defer to the preferences — the trader knows their system better than you do.

Keep responses tight. 2-4 sentences for simple questions; bullet points or a short table when listing things. No preamble ("Great question!"), no closing platitudes. Get to the point.

${contextBlock}`

  // Build the messages array — trader's prior history + new message.
  const history = Array.isArray(body.history) ? body.history.slice(-20) : []  // cap at 20 turns to stay sensible
  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: body.message },
  ]

  // Stream the response back as SSE so the chat panel can show tokens as
  // they arrive — much better UX than waiting 5-10s for the full response.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        const response = await client.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: systemPrompt,
          messages,
        })
        for await (const event of response) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`))
          }
        }
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`))
        controller.close()
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'stream error'
        console.error('[coach] stream failed:', msg)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

/** Pre-aggregate the trader's recent data into a compact context block.
 *  Targets the 180-day window which covers ~90% of relevant patterns
 *  without ballooning tokens. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildCoachContext(supabase: AnyClient): Promise<string> {
  const today = new Date()
  const past180 = new Date(today.getTime() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const past7 = new Date(today.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const past14 = new Date(today.getTime() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10)

  // Fetch trades + the days' day_types (for cross-tabulation)
  const { data: days } = await supabase
    .from('trading_days')
    .select('id, date, day_types, eod_pnl')
    .gte('date', past180)
    .order('date', { ascending: false })
  const dayDateById = new Map<string, string>()
  const dayTypesById = new Map<string, string[]>()
  for (const d of (days ?? []) as Array<{ id: string; date: string; day_types: string[] | null }>) {
    dayDateById.set(d.id, d.date)
    dayTypesById.set(d.id, Array.isArray(d.day_types) ? d.day_types : [])
  }

  const PAGE = 1000
  const trades: Array<{
    id: string
    trading_day_id: string
    entry_time: string | null
    direction: 'long' | 'short' | null
    pnl: number | null
    entry_price: number | null
    stop_price: number | null
    quantity: number | null
    symbol: string | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tags_json: any
    structure_5m_alignment: string | null
  }> = []
  for (let p = 0; p < 10; p++) {
    const { data } = await supabase
      .from('trades')
      .select('id, trading_day_id, entry_time, direction, pnl, entry_price, stop_price, quantity, symbol, tags_json, structure_5m_alignment')
      .in('trading_day_id', Array.from(dayDateById.keys()))
      .order('entry_time', { ascending: false })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || data.length === 0) break
    trades.push(...data)
    if (data.length < PAGE) break
  }

  // ── Aggregates ──
  const total = trades.length
  if (total === 0) return 'NO TRADE DATA — the trader has not logged any trades in the last 180 days.'
  const winners = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losers = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate = total > 0 ? (winners / (winners + losers || 1)) * 100 : 0
  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const sumW = trades.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0)
  const sumL = trades.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
  const profitFactor = sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0)

  // Per-setup performance
  const setupBuckets = new Map<string, { count: number; wins: number; losers: number; pnl: number; rs: number[] }>()
  const mistakeCounts = new Map<string, { count: number; pnl: number }>()
  const dayTypeBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const ofBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const structureBuckets = new Map<string, { count: number; wins: number; pnl: number }>()

  const SYM_MULT: Record<string, number> = { NQ: 20, MNQ: 2, ES: 50, MES: 5 }
  const mult = (s: string | null) => {
    if (!s) return 1
    const root = s.replace(/\.[A-Z]+$/, '').replace(/[HMUZ]\d+$/, '')
    return SYM_MULT[root] ?? 1
  }

  for (const t of trades) {
    const pnl = t.pnl ?? 0
    const isWin = pnl > 0
    const stopDist = (t.entry_price != null && t.stop_price != null) ? Math.abs(t.entry_price - t.stop_price) : null
    const r = (stopDist && t.quantity) ? pnl / (stopDist * t.quantity * mult(t.symbol)) : null

    const setups = (t.tags_json?.setups as string[]) ?? []
    if (setups.length === 0) {
      const b = setupBuckets.get('Discretionary/No Setup') ?? { count: 0, wins: 0, losers: 0, pnl: 0, rs: [] }
      b.count++; if (isWin) b.wins++; if (pnl < 0) b.losers++; b.pnl += pnl; if (r != null) b.rs.push(r)
      setupBuckets.set('Discretionary/No Setup', b)
    } else for (const s of setups) {
      const b = setupBuckets.get(s) ?? { count: 0, wins: 0, losers: 0, pnl: 0, rs: [] }
      b.count++; if (isWin) b.wins++; if (pnl < 0) b.losers++; b.pnl += pnl; if (r != null) b.rs.push(r)
      setupBuckets.set(s, b)
    }

    const mistakes = (t.tags_json?.mistakes as string[]) ?? []
    for (const m of mistakes) {
      const b = mistakeCounts.get(m) ?? { count: 0, pnl: 0 }
      b.count++; b.pnl += pnl
      mistakeCounts.set(m, b)
    }

    const dayTypes = dayTypesById.get(t.trading_day_id) ?? []
    for (const dt of dayTypes) {
      const b = dayTypeBuckets.get(dt) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      dayTypeBuckets.set(dt, b)
    }

    const ofs = (t.tags_json?.order_flow as string[]) ?? []
    for (const o of ofs) {
      const b = ofBuckets.get(o) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      ofBuckets.set(o, b)
    }

    if (t.structure_5m_alignment) {
      const b = structureBuckets.get(t.structure_5m_alignment) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      structureBuckets.set(t.structure_5m_alignment, b)
    }
  }

  // Last 50 trades (newest first)
  const recent = trades.slice(0, 50).map(t => {
    const date = dayDateById.get(t.trading_day_id) ?? '?'
    const dir = t.direction?.[0]?.toUpperCase() ?? '?'
    const setups = ((t.tags_json?.setups as string[]) ?? []).join(',') || '—'
    const mistakes = ((t.tags_json?.mistakes as string[]) ?? []).join(',') || '—'
    const stopDist = (t.entry_price != null && t.stop_price != null) ? Math.abs(t.entry_price - t.stop_price) : null
    const r = (stopDist && t.quantity && t.pnl != null) ? t.pnl / (stopDist * t.quantity * mult(t.symbol)) : null
    return `${date} ${dir}${t.quantity ?? '?'} pnl=${t.pnl?.toFixed(0) ?? '?'}${r != null ? ` R=${r.toFixed(2)}` : ''} setup=[${setups}]${mistakes !== '—' ? ' mistake=['+mistakes+']' : ''}${t.structure_5m_alignment ? ' 5m='+t.structure_5m_alignment : ''}`
  }).join('\n')

  // Week-over-week
  const tradesThisWeek = trades.filter(t => (t.entry_time ?? '').slice(0, 10) >= past7)
  const tradesPriorWeek = trades.filter(t => {
    const d = (t.entry_time ?? '').slice(0, 10)
    return d >= past14 && d < past7
  })
  const wkPnl = (arr: typeof trades) => arr.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wkWR = (arr: typeof trades) => {
    const w = arr.filter(t => (t.pnl ?? 0) > 0).length
    const l = arr.filter(t => (t.pnl ?? 0) < 0).length
    return (w + l) > 0 ? Math.round((w / (w + l)) * 100) : null
  }

  const fmt = (n: number) => (n >= 0 ? '+' : '') + '$' + Math.round(n).toLocaleString()
  const sortByCount = <T extends { count: number }>(map: Map<string, T>, n = 10) =>
    Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, n)
  const sortByPnl = <T extends { pnl: number }>(map: Map<string, T>, n = 10) =>
    Array.from(map.entries()).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, n)

  return `═══ TRADER DATA SUMMARY ═══
Window: last 180 days (${past180} → today). Total trades: ${total}.

OVERALL:
  Win rate: ${winRate.toFixed(0)}% (${winners}W / ${losers}L)
  Total PnL: ${fmt(totalPnl)}
  Profit factor: ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞'}

THIS WEEK vs PRIOR WEEK:
  This week  (${past7} → today): ${tradesThisWeek.length} trades · ${fmt(wkPnl(tradesThisWeek))} · WR ${wkWR(tradesThisWeek) ?? '—'}%
  Prior week (${past14} → ${past7}): ${tradesPriorWeek.length} trades · ${fmt(wkPnl(tradesPriorWeek))} · WR ${wkWR(tradesPriorWeek) ?? '—'}%

SETUP PERFORMANCE (by total PnL, top 10):
${sortByPnl(setupBuckets).map(([s, b]) => `  ${s}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / (b.wins + b.losers || 1)) * 100)}% · avgR ${b.rs.length > 0 ? (b.rs.reduce((s, r) => s + r, 0) / b.rs.length).toFixed(2) : '—'}`).join('\n')}

DAY TYPE PERFORMANCE (by total PnL, top 10):
${sortByPnl(dayTypeBuckets).map(([d, b]) => `  ${d}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n')}

TOP MISTAKES (by frequency, top 10):
${sortByCount(mistakeCounts).map(([m, b]) => `  ${m}: ${b.count} occurrences · ${fmt(b.pnl)} total PnL impact`).join('\n')}

ORDER FLOW SIGNAL PERFORMANCE (by total PnL, top 10):
${sortByPnl(ofBuckets).map(([o, b]) => `  ${o}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no orderflow tags logged in window)'}

5M STRUCTURE ALIGNMENT (this is THIS-trader's signal, not generic):
${Array.from(structureBuckets.entries()).map(([k, b]) => `  ${k}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no structure_5m_alignment values yet — backfill pending)'}

LAST 50 TRADES (newest first, terse format):
${recent}

═══ END TRADER DATA ═══`
}
