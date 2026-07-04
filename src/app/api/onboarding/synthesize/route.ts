import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { consumeAiUsage } from '@/lib/ai-usage'

const client = new Anthropic()

/**
 * POST /api/onboarding/synthesize
 * Drafts a coach-ready Player Profile (preferences_md) + focus (focus_md) from
 * everything the setup wizard captured (trading defaults, tags, scoring profile,
 * "your game" answers). Does NOT save — the wizard shows it editable to confirm.
 * Gated by the per-user AI cap; degrades to an empty draft the user writes.
 */
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const gate = await consumeAiUsage(supabase, 'profile_synth')
  if (!gate.allowed) return NextResponse.json({ error: gate.message, preferences_md: '', focus_md: '', ...gate }, { status: 429 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any
  const { data: prof } = await db.from('trader_profile')
    .select('display_name, default_instrument, account_size, timezone, onboarding_json, scoring_profile_json')
    .eq('id', 'default').maybeSingle()
  const { data: tags } = await db.from('trade_tags').select('category, label')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byCat = (c: string) => (Array.isArray(tags) ? tags.filter((t: any) => t.category === c).map((t: any) => t.label) : [])
  const sp = prof?.scoring_profile_json ?? {}
  const yg = prof?.onboarding_json?.your_game ?? {}

  const profileData = {
    name: prof?.display_name ?? null,
    instrument: prof?.default_instrument ?? null,
    account_size: prof?.account_size ?? null,
    session: sp.session ?? null,
    setups: byCat('setups'),
    confluences: byCat('confluences'),
    uses_orderflow: sp.execution?.uses_orderflow ?? null,
    order_flow_reads: byCat('order_flow'),
    entry_model: byCat('entry_model'),
    rules: { risk_per_trade: sp.risk_per_trade, stop: sp.stop, tp: sp.tp, rails: sp.rails },
    edge: yg.edge ?? null,
    strengths: yg.strengths ?? null,
    leaks: byCat('mistakes'),
    emotional_triggers: byCat('emotions'),
    goal: yg.goal ?? null,
    metrics_that_matter: yg.metrics ?? [],
  }

  const prompt = `You are configuring an AI trading coach's standing context for a trader. Using the structured profile below, write:
1. "preferences_md": a concise markdown "Player Profile" the coach reads before every analysis — their instrument(s), style/edge, playbook (setups / confluences / order-flow / entry model), risk & rules, strengths, and known leaks. Specific and factual, no fluff. If uses_orderflow is false, note they don't trade order flow so the coach must NOT flag them for missing OF reads.
2. "focus_md": a short bulleted markdown list (2–4 bullets) of what to weight MOST right now, driven by their #1 goal and biggest leaks.

Return ONLY compact JSON: {"preferences_md":"...","focus_md":"..."}

Trader profile:
${JSON.stringify(profileData, null, 2)}`

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = message.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n')
    let out: { preferences_md?: string; focus_md?: string } = {}
    try { out = JSON.parse(text) }
    catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]) } catch { /* leave empty */ } } }
    return NextResponse.json({ preferences_md: out.preferences_md ?? '', focus_md: out.focus_md ?? '' })
  } catch {
    return NextResponse.json({ error: 'AI draft is unavailable right now — you can write it yourself below.', preferences_md: '', focus_md: '' })
  }
}
