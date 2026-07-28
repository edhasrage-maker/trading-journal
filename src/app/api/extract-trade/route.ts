import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import type { TradeTag } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { normalizeTradeLevels } from '@/lib/trade-geometry'
import { MULTIPLIERS, symbolRoot } from '@/lib/futures-symbols'
import { clientError } from '@/lib/api-error'

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
    return NextResponse.json({ error: clientError(detail), type: err?.error?.type, status: err?.status }, { status: 500 })
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  if (!LOCAL_FEATURES_ENABLED) {
    const supabase = await createClient()
    const gate = await consumeAiUsage(supabase, 'extract_trade')
    if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
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
    model: 'claude-opus-4-8',
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

The #1 error is reading the BUY/SELL side of the working orders as the position
DIRECTION. That is WRONG on Sierra Chart. Work in this order.

Step 1 — DIRECTION from the POSITION, never from order side or color:
- Find the open-position indicator: a "+N" / "-N" size or a P/L tile ("+5 P/L: 40.00C, 4.00p", "+$40.00 USD"). POSITIVE size = LONG, NEGATIVE = SHORT.
- Working/bracket orders are the EXITS, and their side is the OPPOSITE of the position: a LONG is bracketed by SELL orders (Sell-Limit target ABOVE, Sell-Stop BELOW); a SHORT by BUY orders. So visible "S|Lmt"/"S|Stop" almost always means you are LONG, and "B|Lmt"/"B|Stop" means SHORT. NEVER equate "Sell" with "short".
- Color is P/L (green = profit, red = loss), NOT direction. Never infer long/short from a green or red fill.
- ONLY if the chart shows NO open position (flat) is a lone working order a PENDING ENTRY — then, and only then, a Sell order = a short entry setup.

Step 2 — ENTRY = the position's fill / average price, not an order line:
- Use the "Trade: Qty@PRICE" text, the position average-price line, or the fill marker. If only current price + open P/L are shown, back entry out (long: entry = current − open points; short: current + open points).
- IGNORE any P/L tile ("+$40.00 USD", "+5 P/L: 40.00C, 4.00p") as a price LEVEL — it sits at the CURRENT price, and is never the entry, target, or stop.

Step 3 — STOP vs TP1 by the order's own P&L SIGN and by GEOMETRY, not the Buy/Sell letter:
- A working-order label showing a POSITIVE projected P&L "(+320.00C, 32.00p)" is the TARGET (books a profit if it fills). A NEGATIVE label "(-160.00C, 16.00p)" is the STOP (books a loss). This sign is the most reliable signal — use it.
- Cross-check with geometry: LONG → line ABOVE entry = TP1, line BELOW = stop. SHORT → line ABOVE = stop, line BELOW = TP1.

Step 4 — VALIDATE. The three prices ALWAYS order as:
- LONG:   stop  <  entry  <  TP1   (stop below, target above)
- SHORT:  TP1   <  entry  <  stop   (target below, stop above)
If a value lands on the WRONG side of entry for the direction, you have misread it — re-examine. If you still cannot place it confidently, return null rather than emitting a wrong-sided value. NEVER output a long with stop above entry, or a short with stop below entry.

- Entry time: time at bottom axis at entry point (HH:MM, 24h)
- Quantity (contracts): read it from the OPEN POSITION, never from an order line.
  It is the "+N" / "-N" size in the position / P&L tile you already located in
  Step 1 — "+5 | P/L: 7.50C, 0.75p" means FIVE contracts. Report the absolute
  value (a short's "-5" is quantity 5, not -5).
  Sierra puts several other numbers nearby that are NOT the position size:
  - "TQ:5" inside a working-order label is that bracket's TOTAL quantity. The
    bare number next to the "X" button ("TQ:5  3 | X") is only THAT order's
    share of it, because a bracket can be split across several orders. If you
    must use an order label, take the TQ value, never the bare number.
  - "Trades: 3/7" in a status header is a COUNT of trades taken, not a size.
  - Child / attached order rows ("Child-Client") often show 0.
  If the position tile and a TQ value disagree, trust the position tile. If no
  position size is visible anywhere, return null — do not fall back to a single
  order's quantity, which is usually smaller than the real position.
- Symbol: the TRADED CONTRACT symbol, from the chart header (usually top-left) or
  the position/order labels — e.g. "ESU6.CME", "MNQU6.CME", "NQU6.CME". It always
  looks like root + month-code + year, optionally with an exchange suffix, and it
  NEVER contains spaces.
  Do NOT take it from the chart tab strip along the bottom of the window, a study
  or indicator name, or a timeframe label — "NQ 1M FP", "NQ Daily VPs", "1m HA",
  "Recon Tape" and the like are chart names, not instruments, even though they
  start with a root that looks right.
  Return the EXACT string shown; do not normalize or guess. Null if no real
  contract symbol is visible — null is better than a chart name.

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
  "symbol": string or null,
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

    // Symbol guard — a Sierra window is full of text that looks symbol-ish: the
    // chart tab strip along the bottom ("NQ 1M FP", "NQ Daily VPs"), study
    // names, timeframe labels. One of those getting through is worse than no
    // symbol at all, because symbolToMultiplier() falls back to 1 for an
    // unrecognised root and every dollar figure derived from the trade then
    // comes out silently wrong — R, capture %, MFE/MAE in $ (a 5-lot MNQ read
    // as "NQ 1M FP" graded a $340 risk as $170, printing 1.94R for a ~0.97R
    // trade). Keep the symbol only if its root resolves to a known multiplier.
    if (typeof data.symbol === 'string') {
      const root = symbolRoot(data.symbol.trim())
      if (!(root in MULTIPLIERS)) data.symbol = null
    }

    // Geometry guard — stop/TP1 must sit on the correct side of entry for the
    // direction (long: stop<entry<TP1; short: TP1<entry<stop). The vision model
    // sometimes lays a short's levels out long-style (stop below entry).
    // First recover the pure-swap case (BOTH levels reversed → swap them back)
    // rather than nulling both; then null any single value still wrong-sided
    // (genuinely ambiguous) so the user never gets a backwards stop/target.
    {
      const dir = data.direction
      const e = typeof data.entry_price === 'number' ? data.entry_price : null
      if (e != null && (dir === 'long' || dir === 'short')) {
        const swapped = normalizeTradeLevels({
          direction: dir,
          entry: e,
          stop: typeof data.stop_price === 'number' ? data.stop_price : null,
          tp1: typeof data.tp1_price === 'number' ? data.tp1_price : null,
        })
        data.stop_price = swapped.stop
        data.tp1_price = swapped.tp1
        if (typeof data.stop_price === 'number') {
          const wrong = dir === 'long' ? data.stop_price >= e : data.stop_price <= e
          if (wrong) data.stop_price = null
        }
        if (typeof data.tp1_price === 'number') {
          const wrong = dir === 'long' ? data.tp1_price <= e : data.tp1_price >= e
          if (wrong) data.tp1_price = null
        }
      }
    }

    // Equality guard — a TP or stop that EQUALS the entry is never a real level.
    // It's the vision model latching onto the entry/current-price marker (e.g. the
    // green "+$40 USD" P/L box) for a target/stop, which makes RR nonsensical
    // (0-width reward/risk). Null it. Runs even when direction is unknown, so it
    // backstops the wrong-sided guard above (which needs a known direction).
    {
      const e = typeof data.entry_price === 'number' ? data.entry_price : null
      if (e != null) {
        if (typeof data.tp1_price === 'number' && Math.abs(data.tp1_price - e) < 1e-6) data.tp1_price = null
        if (typeof data.stop_price === 'number' && Math.abs(data.stop_price - e) < 1e-6) data.stop_price = null
      }
    }

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
