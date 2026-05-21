import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { TradeTag } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[extract-trade] failed:', err)
    return NextResponse.json({ error: detail, type: err?.error?.type, status: err?.status }, { status: 500 })
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  // Pull the user's tag library so Claude only suggests labels that actually exist.
  // Without this, suggestions silently fail to highlight in the UI because the names
  // don't match what's in trade_tags.
  const supabase: AnyClient = await createClient()
  const { data: tagRows } = await supabase
    .from('trade_tags')
    .select('category, label')
    .order('sort_order') as { data: Pick<TradeTag, 'category' | 'label'>[] | null }

  const byCategory: Record<string, string[]> = {}
  for (const t of tagRows ?? []) {
    if (!byCategory[t.category]) byCategory[t.category] = []
    byCategory[t.category].push(t.label)
  }
  const setupLabels = byCategory['setups'] ?? []
  const confluenceLabels = byCategory['confluences'] ?? []
  const orderFlowLabels = byCategory['order_flow'] ?? []

  const buffer = await file.arrayBuffer()
  const base64 = Buffer.from(buffer).toString('base64')
  const mediaType = normalizeAnthropicMediaType(file.type)
  if (!mediaType) {
    return NextResponse.json(
      { error: `Unsupported image type "${file.type || 'unknown'}". Re-upload as PNG, JPEG, WebP, or GIF.` },
      { status: 400 },
    )
  }

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `You are reading a Sierra Chart trade screenshot. Extract trade levels AND identify visual signals for tag suggestions.

PART 1 — TRADE LEVELS
- Entry price: "Trade: Qty@PRICE" text, order fill marker, or highlighted axis price
- Stop price: stop-loss line (red/orange) or "Stop" label
- TP1 price: take-profit line (green/teal) or "Target"/"TP" label
- Direction: stop BELOW entry = long, stop ABOVE entry = short
- Entry time: time at bottom axis at entry point (HH:MM, 24h)
- Quantity: contracts shown in order marker or stats overlay

PART 2 — VISUAL SIGNALS (for tag suggestions)

You may ONLY suggest labels from the trader's existing tag library. Pick labels whose meaning best matches what you see in the chart. If nothing matches, leave the array empty. Do not invent new labels. Do not paraphrase.

Available setup labels: ${setupLabels.length ? setupLabels.map(l => `"${l}"`).join(', ') : '(none configured)'}
Available confluence labels: ${confluenceLabels.length ? confluenceLabels.map(l => `"${l}"`).join(', ') : '(none configured)'}
Available order flow labels: ${orderFlowLabels.length ? orderFlowLabels.map(l => `"${l}"`).join(', ') : '(none configured)'}

Visual cues to map to those labels:

Setup cues:
- Failed-auction-style rejection at a level (long upper/lower wick into resistance/support that immediately reverses)
- Volume profile shape: thin/tapered area at entry = low volume node rejection
- Shaded rectangle zones (green = demand, red/pink = supply)
- Break of structure: a clear higher-high or lower-low after consolidation
- VWAP reclaim/reject behavior, IB break or fade, opening range break

Confluence cues — labeled horizontal lines NEAR the entry price:
- "IBH" / "IBL" labels → suggests an IB confluence
- "ONH" / "ONL" labels → suggests an overnight high/low confluence
- "PDH" / "PDL" labels → suggests a prior day high/low confluence
- "VWAP" label or dotted VWAP line near entry
- "20 EMA" / "9 EMA" / similar moving average labels near entry
- High-volume nodes, round numbers, gap edges

Order flow cues (Sierra Chart specific):
- DELTA FADE: bold/large emphasized number or text printed ON TOP of a footprint candle
- DELTA FLIP: small triangle marker above/below a candle (red ▼ = bearish flip, green ▲ = bullish flip)
- ABSORPTION / EXHAUSTION: notably large circular bubble in the delta bubble panel — large RED bubble + LONG trade or large BLUE bubble + SHORT trade indicates absorption/exhaustion
- AGGRESSIVE BUYERS/SELLERS, STACKED IMBALANCE, ICEBERG: visible imbalance stacks or repeated large prints in the footprint

Match the cue you see to the closest label IN THE ALLOWED LISTS ABOVE. Use empty arrays if nothing matches confidently.

Return ONLY valid JSON with no other text:
{
  "entry_price": number or null,
  "stop_price": number or null,
  "tp1_price": number or null,
  "direction": "long" or "short" or null,
  "entry_time": "HH:MM" string or null,
  "quantity": number or null,
  "suggested_tags": {
    "setups": [],
    "confluences": [],
    "order_flow": []
  }
}`,
        },
      ],
    }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    const data = jsonMatch ? JSON.parse(jsonMatch[0]) : {}

    // Defensive: drop any suggested labels not in the allowed library so the UI doesn't
    // silently miss them, and so we never inject novel tag names.
    if (data.suggested_tags && typeof data.suggested_tags === 'object') {
      const filterTo = (allowed: string[], val: unknown): string[] => {
        if (!Array.isArray(val)) return []
        return val.filter((s): s is string => typeof s === 'string' && allowed.includes(s))
      }
      data.suggested_tags = {
        setups: filterTo(setupLabels, data.suggested_tags.setups),
        confluences: filterTo(confluenceLabels, data.suggested_tags.confluences),
        order_flow: filterTo(orderFlowLabels, data.suggested_tags.order_flow),
      }
    }

    return NextResponse.json(data)
  } catch {
    return NextResponse.json({})
  }
}
