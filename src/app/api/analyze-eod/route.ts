import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import type { PrepNotes, AiAnalysis, Trade, MarketContext, EodAiAnalysis } from '@/lib/supabase/types'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'

const client = new Anthropic()

interface AnalyzeEodBody {
  trades: Trade[]
  eodNotes?: string
  prepNotes?: PrepNotes
  prepAnalysis?: AiAnalysis
  marketContext?: Partial<MarketContext>
  imageBase64?: string | null
  imageMediaType?: string | null
}

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: { type?: string; message?: string } }
    const detail = err?.error?.message ?? err?.message ?? 'unknown server error'
    console.error('[analyze-eod] failed:', err)
    return NextResponse.json({ error: detail, type: err?.error?.type, status: err?.status }, { status: 500 })
  }
}

async function handle(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  const body = (await req.json()) as AnalyzeEodBody
  const { trades, eodNotes, prepNotes, prepAnalysis, marketContext, imageBase64, imageMediaType } = body
  const normalizedMediaType = imageBase64 ? normalizeAnthropicMediaType(imageMediaType) : null
  const hasImage = !!imageBase64 && normalizedMediaType != null
  if (imageBase64 && !hasImage) {
    console.warn('[analyze-eod] dropping image — unsupported media type:', imageMediaType)
  }

  const tradesBlock = trades.length === 0
    ? '  No trades taken today.'
    : trades.map((t, i) => {
        const time = t.entry_time ? new Date(t.entry_time).toISOString().slice(11, 19) : '--:--'
        const dir = t.direction?.toUpperCase() ?? '--'
        const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '--'
        const setups = t.tags_json?.setups?.join(', ') || '—'
        const confluences = t.tags_json?.confluences?.join(', ') || '—'
        const mistakes = t.tags_json?.mistakes?.join(', ') || '—'
        const emotions = t.tags_json?.emotions?.join(', ') || '—'
        const mgmt = t.tags_json?.trade_management?.join(', ') || '—'
        // Per-trade notes (trader's own typed reflection on this fill) and
        // recording_commentary (AI frame-grounded read of the same trade) are
        // BOTH richer than the structured tags. Including them lets the EOD
        // coach reason about patterns from real per-trade context instead of
        // just labels. recording_commentary may be the legacy raw-string shape
        // on a handful of pre-normalization rows — handle both.
        const notes = t.notes?.trim()
        const rc = t.recording_commentary
        const commentaryText = typeof rc === 'string'
          ? rc.trim()
          : (rc && typeof rc === 'object' && rc.text) ? rc.text.trim() : ''
        const notesLine = notes ? `\n       notes: ${notes}` : ''
        const commentaryLine = commentaryText ? `\n       AI frame commentary: ${commentaryText}` : ''
        return `  ${i + 1}. ${time} ${dir} @ ${t.entry_price ?? '?'} stop ${t.stop_price ?? '?'} qty ${t.quantity ?? '?'} | PnL ${pnl}
       setups: ${setups} | confluences: ${confluences}
       management: ${mgmt} | mistakes: ${mistakes} | emotions: ${emotions}${notesLine}${commentaryLine}`
      }).join('\n')

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losses = trades.filter(t => (t.pnl ?? 0) < 0).length

  const chartInstructions = hasImage ? `
═══════════════════════════════════════════════
STEP 1 — INDEPENDENT CHART READ (image only)
═══════════════════════════════════════════════
Look ONLY at the EOD chart image. Do NOT reference the trade list yet.
Identify:
- Did price trend, rotate, or chop overall?
- Where were the key turning points / failed auctions / breakouts?
- Volume profile shape and acceptance / rejection zones

Briefly note this read in "summary" before evaluating the executions.

═══════════════════════════════════════════════
STEP 2 — EXECUTION REVIEW (text + chart)
═══════════════════════════════════════════════
Now read the trade list and trader's notes. Compare:
- Did entries align with structural levels visible on the chart?
- Did the chosen setups fit the day type that actually played out?
- Were there obvious missed trades or chased entries?` : ''

  const prompt = `You are an objective trading coach reviewing a trader's completed session${hasImage ? ' and the day\'s chart' : ''}.

The trader uses an MGI-based approach (Market Generated Information). Setups use structural levels (PDH, PDL, IBH, IBL, ONH, ONL, HTF supply/demand). Entry triggers are order-flow based.
${chartInstructions}

Day Prep Summary:
- Bias: ${prepNotes?.bias ?? 'Not set'} ${prepNotes?.bias_notes ?? ''}
- IB Behaviour expected: ${prepNotes?.ib_behaviour ?? 'Not set'}
- Volume Profile expected: ${prepNotes?.volume_profile_shape ?? 'Not set'}
- Mood / Clarity: ${prepNotes?.mood ?? 'Not set'} / ${prepNotes?.market_clarity ?? 'Not set'}
- AI Prep Score (if any): ${prepAnalysis?.score ?? 'N/A'}/10
- Plans planned: ${prepNotes?.trade_plans?.length ?? 0}

Market Context:
- Rvol: ${marketContext?.rvol ?? 'N/A'}
- IB Size: ${marketContext?.ib_size ?? 'N/A'} (vs 10d avg ratio: ${marketContext?.ib_vs_10d_avg ?? 'N/A'})
- ADR: ${marketContext?.adr ?? 'N/A'} | ATR (1m): ${marketContext?.atr_1m ?? 'N/A'}
- PDH/PDL: ${marketContext?.pdh ?? 'N/A'} / ${marketContext?.pdl ?? 'N/A'}
- IBH/IBL: ${marketContext?.ibh ?? 'N/A'} / ${marketContext?.ibl ?? 'N/A'}

Session Summary:
- Trades: ${trades.length} (W ${wins} / L ${losses})
- Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}

Trades Taken (each may include the trader's own notes and a frame-grounded AI commentary written earlier from the OBS recording at the moment of entry/exit — treat the commentary as a separate, independent observation from the structured tags and weave its concrete findings into your session-level analysis where they reinforce or contradict the tags):
${tradesBlock}

Trader's EOD Reflection:
${eodNotes?.trim() || '(none provided)'}

Respond with ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "summary": "<2-3 sentences on overall session quality${hasImage ? '; include your chart read alignment with what the trader did' : ''}>",
  "what_worked": ["<specific behaviour/decision that was a win — be concrete>", "<up to 4 total>"],
  "mistakes": ["<recurring mistake or specific bad decision — cite trades by number/time>", "<up to 5 total>"],
  "patterns": ["<setup/timing/management pattern across trades, e.g. 'all longs taken at extended IB highs'>", "<up to 4 total>"],
  "next_session_focus": ["<actionable focus item for tomorrow>", "<up to 3 total>"],
  "score": <integer 1-10>
}

Be direct. If the day was poor, say so. If a trade should not have been taken, name it. The trader is paying you to be honest, not encouraging.`

  const userContent: Anthropic.MessageParam['content'] = hasImage
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: normalizedMediaType!,
            data: imageBase64!,
          },
        },
        { type: 'text', text: prompt },
      ]
    : prompt

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: userContent }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const fallback: EodAiAnalysis = {
    summary: text,
    what_worked: [],
    mistakes: [],
    patterns: [],
    next_session_focus: [],
    score: 0,
    analyzed_at: new Date().toISOString(),
  }

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return NextResponse.json(fallback)
    const parsed = JSON.parse(jsonMatch[0]) as EodAiAnalysis
    return NextResponse.json({ ...parsed, analyzed_at: new Date().toISOString() })
  } catch {
    return NextResponse.json(fallback)
  }
}
