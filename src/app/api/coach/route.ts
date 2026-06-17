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
import { buildCoachContext } from '@/lib/coach-context'

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
    recentTradesLimit: 50,
  })
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
