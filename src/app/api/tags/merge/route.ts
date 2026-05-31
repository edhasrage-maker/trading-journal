import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { mergeTags } from '@/lib/tag-merge'
import { TAG_CATEGORIES, type TagCategory } from '@/lib/tradezella-import'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * POST /api/tags/merge
 * Body: { category, canonical, victims: string[] }
 *
 * Folds every `victim` label into `canonical` across both trades and
 * historical_trades, then deletes the victim rows from the tag library.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const category = body?.category as TagCategory
  const canonical = body?.canonical as string
  const victims = body?.victims as string[]

  if (!TAG_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `invalid category: ${category}` }, { status: 400 })
  }
  if (!canonical || typeof canonical !== 'string') {
    return NextResponse.json({ error: 'canonical (string) required' }, { status: 400 })
  }
  if (!Array.isArray(victims) || victims.length === 0) {
    return NextResponse.json({ error: 'victims (non-empty string[]) required' }, { status: 400 })
  }
  if (!victims.every(v => typeof v === 'string')) {
    return NextResponse.json({ error: 'victims must all be strings' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const result = await mergeTags(supabase, { category, canonical, victims })
  return NextResponse.json(result)
}
