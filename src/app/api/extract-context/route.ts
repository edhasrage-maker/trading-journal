import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { clientError } from '@/lib/api-error'

const client = new Anthropic()

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[extract-context] failed:', err)
    // Image-rejection 400s are actionable, not sensitive — name them instead
    // of the scrubbed generic (backstop; the client downscales before upload).
    if (err?.status === 400 && /image/i.test(String(detail))) {
      return NextResponse.json(
        { error: 'The screenshot was rejected by the image reader (usually too large). Re-paste it — it is downscaled automatically now — or crop to the relevant pane.' },
        { status: 400 },
      )
    }
    return NextResponse.json({ error: clientError(detail), type: err?.error?.type, status: err?.status }, { status: 500 })
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  if (!LOCAL_FEATURES_ENABLED) {
    const supabase = await createClient()
    const gate = await consumeAiUsage(supabase, 'extract_context')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const buffer = await file.arrayBuffer()
  // Vision API hard limit is ~5 MB per image; say so up front rather than
  // letting the provider 400 surface as a scrubbed 500.
  if (buffer.byteLength > 5_000_000) {
    return NextResponse.json(
      { error: `Screenshot is too large to read (${(buffer.byteLength / 1e6).toFixed(1)} MB). Re-paste it — it is downscaled automatically now — or crop to the relevant pane.` },
      { status: 400 },
    )
  }
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
          text: `You are reading a Sierra Chart trading screenshot. Extract ALL visible market data values. Look carefully at:
- Text overlays/stats panel (usually top-left) for: RVOL/Relative Volume, Day's Range, ADR, IB Range, IB AVG/Average, ATR values
- Price level labels on the right side or drawn horizontal lines for: PDH, PDL, IBH, IBL, ONH, ONL
- The current symbol/instrument name
- The current/live market price (NOT a trade marker — see rules below)

Return ONLY a JSON object with these exact keys (use null if not visible):
{
  "symbol": string or null,
  "pdh": number or null,
  "pdl": number or null,
  "ibh": number or null,
  "ibl": number or null,
  "onh": number or null,
  "onl": number or null,
  "rvol": number or null,
  "day_range": number or null,
  "ib_size": number or null,
  "ib_10d_avg": number or null,
  "ib_vs_10d_avg": number or null,
  "adr": number or null,
  "atr_1m": number or null,
  "current_price": number or null
}

For pdh/pdl/onh/onl/ibh/ibl: the label ("PDL", "IBH", …) names a horizontal LINE. The number is usually NOT written next to the label, so get it in this order:

  METHOD 1 — highlighted price boxes on the scale (USE THIS WHENEVER PRESENT).
  Many charts mark each drawn level with a filled/highlighted value box on the
  right-hand price scale, at exactly the line's height, e.g. a box reading
  "7399.00" level with the "PDL" label. When those boxes exist the price is
  PRINTED — do not estimate. Match each level label to the highlighted box at the
  SAME vertical position and copy that number verbatim. These boxes stand out
  from the regular evenly-spaced axis ticks: they sit at irregular heights and
  are shaded/inverted. A level whose box reads 7399.00 is 7399.00, even if the
  nearest ordinary tick says 7400.00.

  METHOD 2 — only if there are no highlighted boxes. Trace the level's line
  horizontally to the price axis and interpolate between the nearest tick above
  and below.

  Either way: a level can sit FAR from the candles — top or bottom of the plot,
  or inside a shaded band — so do NOT treat a label near an edge as absent. PDL
  in particular is often the lowest thing on the chart, well below all price
  action, and gets missed for exactly that reason.
  If a label is visible but you cannot pin its value confidently, return null for
  it. A wrong level is worse than a missing one: pdh/pdl feed an "is price inside
  yesterday's range" check that silently flips on a bad value.

For ib_10d_avg: extract the raw "IB AVG" value directly (e.g. if you see "IB AVG: 100.50", set ib_10d_avg to 100.50).
For ib_vs_10d_avg: if you see "IB Range" and "IB AVG", compute IB Range / IB AVG as a ratio (e.g. 105 / 100.50 = 1.04).
For atr_1m: prefer ATR-10--1m value if multiple ATR values exist.
For day_range: the "Day's Range" value from the stats overlay (e.g. if you see "Day's Range: 213.50", set day_range to 213.50). Skip if not labeled.
For current_price: the LIVE market price right now. Pick in this order:
  1. A highlighted/colored price label on the right Y-axis (the "current price" highlight box) — this is the most reliable source.
  2. The latest candle close — i.e. the close price of the rightmost bar in the chart area.
  STRICTLY DO NOT extract from "Trade: Qty@PRICE" labels — those are STATIC trade-entry markers from prior fills and are NEVER the current price.
  STRICTLY DO NOT extract from "Trade Activity" lists or any historical trade labels.
  If neither (1) nor (2) is clearly visible, return null. A wrong current_price is worse than a missing one — it causes downstream price_in_pd_range mis-detection.
Return ONLY the JSON, no other text.`,
        },
      ],
    }],
  })

  const text = message.content[0]?.type === 'text' ? message.content[0].text : '{}'
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    const data = jsonMatch ? JSON.parse(jsonMatch[0]) : {}

    // Auto-compute price range booleans from extracted current_price
    const cp: number | null = data.current_price ?? null
    if (cp !== null) {
      if (data.pdh !== null && data.pdl !== null) {
        data.price_in_pd_range = cp >= data.pdl && cp <= data.pdh
      }
      if (data.onh !== null && data.onl !== null) {
        data.price_in_gbx_range = cp >= data.onl && cp <= data.onh
      }
    }
    delete data.current_price

    // Auto-compute GBX % of ADR
    if (data.onh !== null && data.onl !== null && data.adr !== null && data.adr > 0) {
      data.gbx_pct_adr = parseFloat(((data.onh - data.onl) / data.adr * 100).toFixed(2))
    }

    return NextResponse.json(data)
  } catch {
    return NextResponse.json({})
  }
}
