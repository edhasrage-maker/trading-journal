import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { TagCategory } from '@/lib/supabase/types'
import { ensureTag } from '@/lib/tag-library-server'
import { clientError } from '@/lib/api-error'
import { resolveTagCategories } from '@/lib/tag-categories'
import { categoryKeysInUse, readCategoryPrefs } from '@/lib/tag-categories-server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

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

  // The category list is per-trader now (built-ins minus hidden, plus their own
  // axes), so validate against what THIS trader actually has rather than a
  // hardcoded union — otherwise a custom category could never hold a tag.
  const categories = resolveTagCategories(
    await readCategoryPrefs(supabase),
    await categoryKeysInUse(supabase),
  )
  if (!category || !categories.some(c => c.key === category)) {
    return NextResponse.json({ error: `Invalid category: ${category}` }, { status: 400 })
  }
  if (!label) {
    return NextResponse.json({ error: 'Label cannot be empty' }, { status: 400 })
  }
  if (label.length > 80) {
    return NextResponse.json({ error: 'Label too long (max 80 chars)' }, { status: 400 })
  }

  // Key-based dedup (tagKey) and the alphabetical slot: src/lib/tag-library-server.ts.
  try {
    const { tag, created } = await ensureTag(supabase, category, label)
    return NextResponse.json({ tag, created })
  } catch (e) {
    return NextResponse.json({ error: clientError(e) }, { status: 500 })
  }
}
