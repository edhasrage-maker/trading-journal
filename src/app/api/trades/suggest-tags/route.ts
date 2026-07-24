import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { consumeAiUsage } from '@/lib/ai-usage'
import { createClient } from '@/lib/supabase/server'
import type { TradeTags, TagCategory } from '@/lib/supabase/types'
import { getTraderProfile, profileContextBlock } from '@/lib/trader-profile'
import { followFade, type Regime } from '@/lib/market-structure'

const client = new Anthropic()

/**
 * POST /api/trades/suggest-tags
 * Body: { notes: string, existing?: TradeTags }
 *
 * Semantic counterpart to the keyword matcher in src/lib/suggest-tags.ts. The
 * keyword version (which auto-adds as the user types) only fires when the
 * trader's words literally overlap a tag's label; this route reads the *meaning*
 * of the notes and proposes tags the trader described in their own words
 * ("waited for it to come back to me" → Patience), constrained to the trader's
 * real tag library so it can never invent labels.
 *
 * Returns suggestions as a TradeTags object. The client surfaces them as the
 * yellow "suggested" chips (accept-to-add) — NOT auto-added — so an AI guess
 * never silently lands on a trade. `existing` is excluded from the output so we
 * don't re-suggest tags already on the trade.
 */

// Categories worth suggesting from free-text notes. day_type is excluded — it's
// structural / auto-tagged (RTH vs GBX), not something described in notes.
const SUGGESTABLE: TagCategory[] = [
  'setups', 'confluences', 'order_flow', 'entry_model', 'trade_management', 'mistakes', 'emotions',
]

/** Deterministic 5m-structure confluence labels. `followFade(side, regime)` is
 *  exact math, so these are suggested from the trade's stored
 *  `structure_5m_regime` — never guessed by the model. Labels must exist in the
 *  trader's library (migration 20260718_structure_confluence_tags) or the
 *  suggestion is silently skipped, so this degrades cleanly pre-migration. */
const STRUCTURE_TAG: Record<'follow' | 'fade', string> = {
  follow: 'Follow LTF structure',
  fade: 'Fade LTF structure',
}

export async function POST(req: Request) {
  let body: { notes?: string; existing?: TradeTags; tradeId?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const notes = (body.notes ?? '').trim()
  const tradeId = typeof body.tradeId === 'string' ? body.tradeId : null
  // The model only runs on real prose; the structure suggestion below is pure
  // math and works with no notes at all (imported trades often have none).
  const wantModel = notes.length >= 3
  if (!wantModel && !tradeId) return NextResponse.json({ suggestions: {} })
  if (wantModel && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = await createClient()
  const { data: tagRows } = await supabase
    .from('trade_tags')
    .select('label, category')
    .order('sort_order') as { data: { label: string; category: TagCategory }[] | null }

  // Group the library by category, keeping only the suggestable categories.
  const library = new Map<TagCategory, string[]>()
  for (const r of tagRows ?? []) {
    if (!SUGGESTABLE.includes(r.category)) continue
    const arr = library.get(r.category) ?? []
    if (!arr.includes(r.label)) arr.push(r.label)
    library.set(r.category, arr)
  }
  if (library.size === 0) return NextResponse.json({ suggestions: {} })

  // Set of valid "category|label" keys to constrain the model's output.
  const validKeys = new Set<string>()
  for (const [cat, labels] of library) for (const l of labels) validKeys.add(`${cat}|${l}`)

  // Already-applied tags, so we don't re-suggest them.
  const existingKeys = new Set<string>()
  for (const cat of Object.keys(body.existing ?? {}) as TagCategory[]) {
    for (const l of (Array.isArray(body.existing?.[cat]) ? body.existing![cat] : []) as string[]) {
      existingKeys.add(`${cat}|${l}`)
    }
  }

  // ── Deterministic: 5m market-structure follow/fade ─────────────────────────
  // The regime is computed at SC-log import (import-sc-log step 4d) and stored
  // on the trade, so follow/fade is EXACT math — never a model guess. Only a
  // decided bull/bear regime yields a tag; neutral/insufficient suggest nothing
  // (precision over recall, same bar as the rest of this route).
  const suggestions: Partial<Record<TagCategory, string[]>> = {}
  if (tradeId) {
    const { data: tRow } = await supabase
      .from('trades')
      .select('direction, structure_5m_regime')
      .eq('id', tradeId)
      .maybeSingle() as { data: { direction: 'long' | 'short' | null; structure_5m_regime: Regime | null } | null }
    const dir = tRow?.direction
    const regime = tRow?.structure_5m_regime
    if (dir && regime) {
      const ff = followFade(dir, regime)
      if (ff === 'follow' || ff === 'fade') {
        const label = STRUCTURE_TAG[ff]
        const key = `confluences|${label}`
        // Skip when the label isn't in the library yet (pre-migration) or the
        // trader already applied it.
        if (validKeys.has(key) && !existingKeys.has(key)) suggestions.confluences = [label]
      }
    }
  }

  // Nothing more to do without prose — return the structural suggestion alone
  // (and never spend an AI-usage unit on it).
  if (!wantModel) return NextResponse.json({ suggestions: suggestions as TradeTags })

  // The model path is the only thing that costs quota, so gate it here rather
  // than at the top of the route.
  if (!LOCAL_FEATURES_ENABLED) {
    const gate = await consumeAiUsage(supabase, 'suggest_tags')
    if (!gate.allowed) {
      // Out of quota still returns the deterministic suggestion — it's free.
      return NextResponse.json({ suggestions: suggestions as TradeTags, ...gate, error: gate.message }, { status: 429 })
    }
  }

  const libraryBlock = SUGGESTABLE
    .filter(cat => library.has(cat))
    .map(cat => `${cat}:\n${library.get(cat)!.map(l => `  - ${l}`).join('\n')}`)
    .join('\n\n')

  const traderProfile = await getTraderProfile()
  const prompt = profileContextBlock(traderProfile) + `You are tagging a futures trade from the trader's own free-text notes. Read what they wrote and select the tags that genuinely match the MEANING of the notes — including paraphrases (e.g. "waited for it to come back to me" → a patience/discipline tag; "chased it" → an FOMO/late-entry mistake).

Rules:
- ONLY choose from the tag library below. Copy labels VERBATIM. Never invent a label or a category.
- Suggest a tag only when the notes clearly support it. Precision over recall — a few confident tags beat a long speculative list. It is fine to return nothing.
- Do NOT suggest emotions/mistakes that aren't described; do not infer a setup the notes don't mention.

Tag library (category → available labels):

${libraryBlock}

Trader's notes:
"""
${notes}
"""

Return the tags you're confident the notes describe.`

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              tags: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: { type: 'string' },
                    label: { type: 'string' },
                  },
                  required: ['category', 'label'],
                  additionalProperties: false,
                },
              },
            },
            required: ['tags'],
            additionalProperties: false,
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    let parsed: { tags?: Array<{ category?: string; label?: string }> } = {}
    try { parsed = JSON.parse(text) } catch { parsed = {} }

    // Merge the model's picks INTO the deterministic suggestion (which already
    // holds the structure confluence, if any).
    for (const t of parsed.tags ?? []) {
      if (typeof t?.category !== 'string' || typeof t?.label !== 'string') continue
      const cat = t.category as TagCategory
      const key = `${cat}|${t.label}`
      // Drop hallucinated labels and anything already on the trade.
      if (!validKeys.has(key) || existingKeys.has(key)) continue
      const arr = suggestions[cat] ?? []
      if (!arr.includes(t.label)) arr.push(t.label)
      suggestions[cat] = arr
    }

    return NextResponse.json({ suggestions: suggestions as TradeTags })
  } catch (e) {
    const err = e as { message?: string; error?: { message?: string }; status?: number }
    console.error('[trades/suggest-tags] failed:', err)
    // A model failure must not swallow the deterministic structure suggestion.
    if (Object.keys(suggestions).length > 0) {
      return NextResponse.json({ suggestions: suggestions as TradeTags })
    }
    return NextResponse.json(
      { error: err?.error?.message ?? err?.message ?? 'tag suggestion failed' },
      { status: err?.status ?? 500 },
    )
  }
}
