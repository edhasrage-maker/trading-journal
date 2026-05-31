import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

const client = new Anthropic()

interface SummaryTrade {
  id: string
  direction?: string | null
  entry_price?: number | null
  pnl?: number | null
  quantity?: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json?: any
  notes?: string | null
}

/**
 * POST /api/trades/summary
 * Body: { trades: SummaryTrade[] }
 *
 * Returns a 1-2 line plain-language narrative per trade, woven from its tags
 * (setups / order flow / confluences / management / mistakes) plus the trader's
 * own notes — e.g. "Dicey long but saw 3 failures at IBL with absorption and a
 * delta fade, so I entered above the cluster and targeted the imbalance."
 *
 * The whole day's trades are summarized in ONE call; the client caches results
 * by content hash so this only runs when a trade's tags/notes actually change.
 */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  let trades: SummaryTrade[] = []
  try {
    const body = (await req.json()) as { trades?: SummaryTrade[] }
    trades = Array.isArray(body.trades) ? body.trades : []
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  if (trades.length === 0) return NextResponse.json({ summaries: {} })

  const block = trades.map(t => {
    const dir = t.direction?.toUpperCase() ?? '—'
    const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'
    const tj = t.tags_json ?? {}
    const exits = Array.isArray(t.exits_json) && t.exits_json.length > 0
      ? t.exits_json.map((e: { qty?: number; price?: number }) => `${e.qty ?? '?'}@${e.price ?? '?'}`).join(', ')
      : '—'
    const list = (v: unknown) => Array.isArray(v) ? (v.join(', ') || '—') : (v || '—')
    return `id: ${t.id}
  dir/size: ${dir} ${t.quantity ?? '?'} @ ${t.entry_price ?? '?'} | exits: ${exits} | PnL ${pnl}
  setups: ${list(tj.setups)} | order_flow: ${list(tj.order_flow)} | confluences: ${list(tj.confluences)}
  management: ${list(tj.trade_management)} | mistakes: ${list(tj.mistakes)} | day_type: ${list(tj.day_type)}
  notes: ${t.notes?.trim() || '(none)'}`
  }).join('\n\n')

  const prompt = `You are summarizing a futures trader's individual trades for their journal. The trader uses an MGI / order-flow approach with structural levels (PDH/PDL, IBH/IBL, ONH/ONL, VWAP) and order-flow triggers (absorption, exhaustion, delta, stacked imbalance).

For EACH trade below, write ONE punchy 1-2 line summary in the trader's own voice that weaves together the thesis: the setup + where it happened (confluence), the order-flow trigger, how it was managed/targeted, and the gist of any notes. Mention a mistake only if tagged. Keep it concrete and readable — like a human recap, not a list of tags.

Example style: "Dicey long but saw selling fail a 3rd time at IBL with absorption and a delta fade, so I entered above the cluster and targeted the stacked imbalance."

Trades:
${block}

Respond with ONLY valid JSON (no markdown, no code fences), mapping each trade id to its summary string:
{ "summaries": { "<id>": "<1-2 line summary>", ... } }`

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return NextResponse.json({ summaries: {} })
    const parsed = JSON.parse(jsonMatch[0]) as { summaries?: Record<string, string> }
    return NextResponse.json({ summaries: parsed.summaries ?? {} })
  } catch (e) {
    const err = e as { message?: string; error?: { message?: string } }
    console.error('[trades/summary] failed:', err)
    return NextResponse.json({ error: err?.error?.message ?? err?.message ?? 'summary failed' }, { status: 500 })
  }
}
