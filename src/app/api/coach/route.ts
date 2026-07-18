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
import { getTraderProfile, profileContextBlock, focusContextBlock } from '@/lib/trader-profile'
import { buildCoachContext } from '@/lib/coach-context'
import { consumeAiUsage } from '@/lib/ai-usage'
import { normalizeAnthropicMediaType, type AnthropicMediaType } from '@/lib/anthropic-image'
import { ANALYSIS_APPROACH } from '@/lib/coach-methodology'

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
  /** Optional chart images for the CURRENT turn only, as data URLs
   *  ("data:image/png;base64,..."). History stays text-only to keep tokens
   *  and client storage sane. Unsupported types are dropped, not rejected. */
  images?: string[]
  /** Response verbosity. 'highlights' (default) = short verdict + offer to
   *  drill in; 'detailed' = full trade-by-trade tape, no asking first. */
  mode?: 'highlights' | 'detailed'
}

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: AnthropicMediaType; data: string } }

/** Parse data-URL images into Anthropic image blocks. Drops anything that
 *  isn't a base64 data URL of a supported media type. Capped at 4. */
function parseImages(images: unknown): ImageBlock[] {
  if (!Array.isArray(images)) return []
  const out: ImageBlock[] = []
  for (const url of images.slice(0, 4)) {
    if (typeof url !== 'string') continue
    const m = url.match(/^data:([^;]+);base64,(.+)$/)
    if (!m) continue
    const media = normalizeAnthropicMediaType(m[1])
    if (!media) continue
    out.push({ type: 'image', source: { type: 'base64', media_type: media, data: m[2] } })
  }
  return out
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

  // Per-user daily cap. Consume BEFORE the expensive context build + model call.
  // Fail-open on the personal DB (no ai_usage RPC) so local mode is unaffected.
  const gate = await consumeAiUsage(supabase, 'coach_chat')
  if (!gate.allowed) {
    return new Response(JSON.stringify({ error: gate.message, ...gate }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Build the coach context block. The same helper backs the weekly recap
  // synthesis (with a narrower window), guaranteeing chatbox and recap
  // agree on overlapping data.
  const today = new Date().toISOString().slice(0, 10)
  const past180 = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const contextBlock = await buildCoachContext(supabase, {
    startDate: past180,
    endDate: today,
    windowLabel: 'last 180 days',
    includeWeekOverWeek: true,
    // 150 recent trades in row-level detail (was 50). Plus the monthly
    // breakdown + all the aggregate sections, the coach can now answer
    // month-over-month questions AND recall individual trades deeper into
    // the history. ~150 terse rows is well within sonnet's context budget.
    recentTradesLimit: 150,
  })
  const traderProfile = await getTraderProfile()

  const detailed = body.mode === 'detailed'
  const styleInstruction = detailed
    ? `The trader is in DETAILED (tape) mode — give MORE depth than Highlights, but stay CONCISE and skimmable, NEVER a novel. Lead with the verdict/answer, then only the breakdown that earns its space: the main KPIs and the FEW trades that actually drive the point — not a line for every trade. Use a compact table ONLY when it genuinely aids clarity (a handful of rows, not an exhaustive dump). Do NOT write full multi-section audits unless they explicitly ask for "everything" / "the full breakdown." Every line must carry information — no preamble ("Great question!"), no closing platitudes.`
    : `Keep responses VERY SHORT (the trader is in HIGHLIGHTS mode). Lead with the verdict/answer in 1-2 sentences, then AT MOST 2-3 bullets for what matters, citing only the KPIs that support the point (a couple of numbers, not a stat dump). NO per-trade tables, NO multi-section audits, NO line-per-trade. Simple factual questions: 1-2 sentences and stop. When a deeper breakdown exists (trade-by-trade, a specific example, the full list), do NOT pre-empt it — END by OFFERING it in one short line ("Want the trade-by-trade?") and only expand if they ask. No preamble ("Great question!"), no closing platitudes. Get to the point.`

  // Shared diagnostic order (coach + weekly recap use the same text) plus a
  // chat-specific lead-in about leading broad questions with the altitude check.
  const analysisApproach = `${ANALYSIS_APPROACH}

LEAD any broad question ("how am I doing", "where do I improve") with the FOUNDATION/altitude check above before drilling into individual trades. Each recent trade below shows qty, $ pnl, and ×ATR so you can pull size apart per point 4.`

  // Inquisitive behaviour — probe on behavioural input, stay direct on data.
  const probeDirective = `PROBE WHEN IT'S BEHAVIOURAL, ANSWER WHEN IT'S FACTUAL. When the trader describes a DECISION, a FEELING, or their REASONING ("I moved my stop", "I felt rushed", "I bailed because it looked weak"), don't just react — end with ONE sharp "why" follow-up that surfaces the driver (what they saw, what they felt, which rule was in play). But when they ask a direct DATA question ("how did I do month over month?", "win rate on range days?"), just answer with the numbers — do NOT interrogate. One probe max, never an interview, never stack questions. In Highlights mode, this behavioural probe REPLACES the generic "want me to drill in?" offer — don't do both.`

  const imageBlocks = parseImages(body.images)
  const visionNote = imageBlocks.length > 0
    ? `\n\nThe trader attached ${imageBlocks.length} chart image(s) with this message. Read visible price structure, levels, and gross orderflow (obvious absorption/exhaustion/imbalance zones) confidently — but do NOT invent precise delta or footprint numbers; vision is unreliable on dense footprint text. If a specific delta read matters, describe what you can see and ask them to confirm from the chart. Tie what you see back to their logged data and profile.`
    : ''

  // Prompt-caching split: everything byte-stable within a conversation (profile,
  // role text, methodology, the big trade-history context block, focus) goes in
  // one block with a cache_control breakpoint; per-turn pieces (styleInstruction
  // toggles with body.mode, visionNote only exists when images are attached) go
  // in a second block AFTER the breakpoint so they can't invalidate the prefix.
  // Turn 1 writes the cache (~1.25x); turns 2+ within the 5-min TTL read it at
  // ~0.1x — the context block is ~90% of input tokens, so this is the whole win.
  const stableSystemPrompt = `${profileContextBlock(traderProfile)}You are the trader's personal coach, embedded in their trading journal app. You have access to their trading history (summarized below). Your job: answer their questions directly using their actual data. Be SPECIFIC — cite trade counts, dates, PnL figures, win rates, tag names. Don't give generic trading advice; reference what THIS trader has actually done.

When the data doesn't support a confident answer, say so explicitly ("I don't have enough trades in this bucket to call it") rather than guessing. When the trader's coaching preferences (above) conflict with what generic advice would suggest, ALWAYS defer to the preferences — the trader knows their system better than you do.

${analysisApproach}

${probeDirective}

${contextBlock}${focusContextBlock(traderProfile)}`

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: stableSystemPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `${styleInstruction}${visionNote}` },
  ]

  // Build the messages array — trader's prior history + new message. History is
  // text-only; images ride on the current turn's content array (images first).
  const history = Array.isArray(body.history) ? body.history.slice(-20) : []  // cap at 20 turns to stay sensible
  const currentContent: Anthropic.MessageParam['content'] = imageBlocks.length > 0
    ? [...imageBlocks, { type: 'text', text: body.message }]
    : body.message
  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: currentContent },
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
          system: systemBlocks,
          messages,
        })
        let usage: { input: number; cache_write: number; cache_read: number } | null = null
        for await (const event of response) {
          if (event.type === 'message_start') {
            // Cache validation: turn 1 should show cache_write > 0, turns 2+
            // (within the 5-min TTL) cache_read > 0. If read stays 0 across
            // turns, a silent invalidator crept into the stable prefix.
            const u = event.message.usage
            usage = {
              input: u.input_tokens,
              cache_write: u.cache_creation_input_tokens ?? 0,
              cache_read: u.cache_read_input_tokens ?? 0,
            }
            console.log(`[coach] tokens: input=${usage.input} cache_write=${usage.cache_write} cache_read=${usage.cache_read}`)
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`))
          }
        }
        // Trailing diagnostic event — the chat client ignores chunks without
        // text/error, so this only surfaces in the network tab / curl output.
        if (usage) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage })}\n\n`))
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
