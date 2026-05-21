import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'

const client = new Anthropic()

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[extract-context] failed:', err)
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
          text: `You are reading a Sierra Chart trading screenshot. Extract ALL visible market data values. Look carefully at:
- Text overlays/stats panel (usually top-left) for: RVOL/Relative Volume, ADR, IB Range, IB AVG/Average, ATR values
- Price level labels on the right side or drawn horizontal lines for: PDH, PDL, IBH, IBL, ONH, ONL
- The current symbol/instrument name
- The current price: look for a dotted horizontal line with a price label, a highlighted/flashing price on the right axis, or the price shown next to "Trade:" in the stats overlay

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
  "ib_size": number or null,
  "ib_10d_avg": number or null,
  "ib_vs_10d_avg": number or null,
  "adr": number or null,
  "atr_1m": number or null,
  "current_price": number or null
}

For ib_10d_avg: extract the raw "IB AVG" value directly (e.g. if you see "IB AVG: 100.50", set ib_10d_avg to 100.50).
For ib_vs_10d_avg: if you see "IB Range" and "IB AVG", compute IB Range / IB AVG as a ratio (e.g. 105 / 100.50 = 1.04).
For atr_1m: prefer ATR-10--1m value if multiple ATR values exist.
For current_price: the active market price shown as a dotted line, the price after "Trade: Qty@PRICE", or a highlighted box on the right price axis.
Return ONLY the JSON, no other text.`,
        },
      ],
    }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
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
