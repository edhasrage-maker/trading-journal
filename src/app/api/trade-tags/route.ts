import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TagCategory, TradeTag } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const VALID_CATEGORIES: TagCategory[] = [
  'setups',
  'confluences',
  'order_flow',
  'entry_model',
  'trade_management',
  'day_type',
  'mistakes',
  'emotions',
]

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data } = await supabase.from('trade_tags').select('*').order('sort_order')
  return NextResponse.json(data ?? [])
}

/** Create a custom tag. Idempotent — duplicates (same category+label) return
 *  the existing row instead of erroring, so the client can pre-select it
 *  without caring whether it was just created or already existed. */
export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json().catch(() => ({})) as { category?: string; label?: string }
  const category = (body.category ?? '').trim() as TagCategory
  const label = (body.label ?? '').trim()

  if (!category || !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `Invalid category: ${category}` }, { status: 400 })
  }
  if (!label) {
    return NextResponse.json({ error: 'Label cannot be empty' }, { status: 400 })
  }
  if (label.length > 80) {
    return NextResponse.json({ error: 'Label too long (max 80 chars)' }, { status: 400 })
  }

  // Already exists? Return it — caller treats this as success.
  const { data: existing } = await supabase
    .from('trade_tags')
    .select('*')
    .eq('category', category)
    .eq('label', label)
    .maybeSingle() as { data: TradeTag | null }
  if (existing) return NextResponse.json({ tag: existing, created: false })

  // Place after the current last chip in this category.
  const { data: maxRow } = await supabase
    .from('trade_tags')
    .select('sort_order')
    .eq('category', category)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { sort_order: number | null } | null }
  const nextSort = (maxRow?.sort_order ?? 0) + 10

  const { data: inserted, error } = await supabase
    .from('trade_tags')
    .insert({ category, label, sort_order: nextSort })
    .select('*')
    .single() as { data: TradeTag | null; error: { message: string } | null }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ tag: inserted, created: true })
}
