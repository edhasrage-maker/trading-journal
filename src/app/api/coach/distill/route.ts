/**
 * POST /api/coach/distill
 * Body: { messages: Array<{ role: 'user'|'assistant', content: string }> }
 *
 * End-of-conversation distiller for the COACHING THREAD. Fired (fire-and-forget,
 * keepalive) by CoachChat when a conversation is archived. Takes the finished
 * chat + the trader's currently-open thread items and, in ONE Sonnet call:
 *   1. extracts NEW durable directives / commitments, and
 *   2. reconciles which prior open items this conversation advanced.
 * Then writes: inserts new items, applies status updates, and ages the open
 * list down to MAX_OPEN_ITEMS. See src/lib/coaching-thread.ts for the shapes.
 *
 * Fail-soft throughout — this is background memory-keeping, never user-facing.
 * Returns a small JSON summary (the client ignores it).
 */

import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import {
  buildDistillPrompt,
  parseDistillResponse,
  fetchOpenThread,
  MAX_OPEN_ITEMS,
} from '@/lib/coaching-thread'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface DistillBody {
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, reason: 'no-api-key' }, { status: 503 })
  }

  let body: DistillBody
  try { body = (await req.json()) as DistillBody }
  catch { return NextResponse.json({ ok: false, reason: 'bad-body' }, { status: 400 }) }

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-40)   // cap — only the tail of a long chat carries the live directives
  // Need at least one real exchange (a trader turn + a coach turn) to distill.
  const hasExchange = messages.some(m => m.role === 'user') && messages.some(m => m.role === 'assistant')
  if (!hasExchange) return NextResponse.json({ ok: true, skipped: 'no-exchange' })

  const supabase: AnyClient = await createClient()

  // Per-user daily cap (public build only). Fire-and-forget, so on a 429 we just
  // stop — no thread update this time, no error surfaced.
  if (!LOCAL_FEATURES_ENABLED) {
    const gate = await consumeAiUsage(supabase, 'coach_distill')
    if (!gate.allowed) return NextResponse.json({ ok: true, skipped: 'rate-limited' })
  }

  const priorOpen = await fetchOpenThread(supabase)

  // ── Distill ────────────────────────────────────────────────────────────────
  let result
  try {
    const prompt = buildDistillPrompt(messages, priorOpen)
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    result = parseDistillResponse(text)
  } catch (e) {
    console.warn('[coach/distill] model call failed:', e)
    return NextResponse.json({ ok: false, reason: 'model-failed' })
  }

  const priorIds = new Set(priorOpen.map(i => i.id))
  const nowIso = new Date().toISOString()

  // ── Apply status updates to prior open items ────────────────────────────────
  let updated = 0
  for (const u of result.updates) {
    if (!priorIds.has(u.id)) continue   // only touch items we actually showed the model
    const { error } = await supabase
      .from('coaching_thread')
      .update({ status: u.status, updated_at: nowIso, last_seen_at: nowIso })
      .eq('id', u.id)
    if (!error) updated++
  }

  // ── Insert new items ────────────────────────────────────────────────────────
  // user_id fills from the column default (auth.uid()) on the public build; the
  // personal DB has no such column, so we never pass it. RLS scopes the write.
  const toInsert = result.items.slice(0, MAX_OPEN_ITEMS).map(it => ({
    category: it.category,
    directive: it.directive,
    commitment: it.commitment ?? null,
    evidence_hint: it.evidence_hint ?? null,
    status: 'open',
    source: 'coach_chat',
  }))
  let inserted = 0
  if (toInsert.length > 0) {
    const { error } = await supabase.from('coaching_thread').insert(toInsert)
    if (error) console.warn('[coach/distill] insert failed:', error.message)
    else inserted = toInsert.length
  }

  // ── Age out: keep only the newest MAX_OPEN_ITEMS open items ─────────────────
  // Prevents the injected block (and the next distill's prior-list) from growing
  // unbounded. Oldest overflow is marked 'dropped', not deleted (cheap history).
  await ageOutOpenItems(supabase, nowIso)

  return NextResponse.json({ ok: true, inserted, updated })
}

/** If more than MAX_OPEN_ITEMS rows are 'open', mark the oldest overflow
 *  'dropped' so the live set stays bounded. Best-effort. */
async function ageOutOpenItems(supabase: AnyClient, nowIso: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('coaching_thread')
      .select('id')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
    const rows = (data ?? []) as Array<{ id: string }>
    if (rows.length <= MAX_OPEN_ITEMS) return
    const overflow = rows.slice(MAX_OPEN_ITEMS).map(r => r.id)
    if (overflow.length === 0) return
    await supabase
      .from('coaching_thread')
      .update({ status: 'dropped', updated_at: nowIso })
      .in('id', overflow)
  } catch (e) {
    console.warn('[coach/distill] age-out skipped:', e)
  }
}
