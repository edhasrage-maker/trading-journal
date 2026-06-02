import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { TAG_CATEGORIES, type TagCategory } from '@/lib/tradezella-import'
import { looseKey } from '@/lib/tag-merge'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000

/**
 * GET /api/tags/stats
 *
 * Returns the full tag library plus per-tag usage counts across both
 * `trades` and `historical_trades`, and the auto-detected duplicate clusters
 * (labels in the same category whose looseKey collides).
 */
export async function GET() {
  const supabase: AnyClient = await createClient()

  const { data: tagRows, error: tagErr } = await supabase
    .from('trade_tags')
    .select('id, category, label, sort_order')
    .order('category')
    .order('sort_order')
  if (tagErr) return NextResponse.json({ error: tagErr.message }, { status: 500 })

  // Pre-init per-category counters with every library label at 0 so newly-
  // added/unused tags appear in the UI.
  const counts: Record<TagCategory, Map<string, number>> = {
    setups: new Map(), confluences: new Map(), order_flow: new Map(), entry_model: new Map(),
    trade_management: new Map(), day_type: new Map(), mistakes: new Map(), emotions: new Map(),
  }
  for (const t of (tagRows ?? []) as { category: TagCategory; label: string }[]) {
    if (TAG_CATEGORIES.includes(t.category)) counts[t.category].set(t.label, 0)
  }

  const tallyTagsJson = (tj: unknown) => {
    if (!tj || typeof tj !== 'object') return
    const j = tj as Record<string, unknown>
    for (const c of TAG_CATEGORIES) {
      const v = j[c]
      if (c === 'day_type') {
        if (typeof v === 'string' && v) counts.day_type.set(v, (counts.day_type.get(v) ?? 0) + 1)
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string' && item) {
            const m = counts[c]
            m.set(item, (m.get(item) ?? 0) + 1)
          }
        }
      }
    }
  }

  // Paginate both source tables (Supabase 1000-row cap).
  for (const table of ['trades', 'historical_trades'] as const) {
    for (let p = 0; p < 50; p++) {
      const { data, error } = await supabase
        .from(table)
        .select('id, tags_json')
        .order('id', { ascending: true })
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) break
      const rows = (data ?? []) as Array<{ id: string; tags_json: unknown }>
      for (const r of rows) tallyTagsJson(r.tags_json)
      if (rows.length < PAGE) break
    }
  }

  // Build the response per-category: tag rows annotated with usage, plus
  // auto-detected duplicate clusters (labels sharing a looseKey).
  const result: Record<TagCategory, {
    tags: Array<{ id: string; label: string; usage: number; orphan: boolean }>
    clusters: string[][]
  }> = {} as never
  const tagsByCatLabel = new Map<string, { id: string; sort_order: number | null }>()
  for (const t of (tagRows ?? []) as { id: string; category: TagCategory; label: string; sort_order: number | null }[]) {
    tagsByCatLabel.set(`${t.category}|${t.label}`, { id: t.id, sort_order: t.sort_order })
  }
  for (const cat of TAG_CATEGORIES) {
    // Every label seen anywhere (library or in tags_json that was never added
    // to the library — orphans). Orphans surface so users can fold them too.
    const all = new Set<string>(counts[cat].keys())
    const tagsOut: Array<{ id: string; label: string; usage: number; orphan: boolean }> = []
    for (const label of all) {
      const meta = tagsByCatLabel.get(`${cat}|${label}`)
      tagsOut.push({
        id: meta?.id ?? `orphan:${cat}:${label}`,
        label,
        usage: counts[cat].get(label) ?? 0,
        orphan: !meta,
      })
    }
    // Sort: highest usage first, then alphabetical (stable).
    tagsOut.sort((a, b) => (b.usage - a.usage) || a.label.localeCompare(b.label))

    // Cluster by looseKey — pre-filter to clusters with >=2 distinct labels.
    const byKey = new Map<string, string[]>()
    for (const t of tagsOut) {
      const k = looseKey(t.label)
      if (!k) continue
      const arr = byKey.get(k) ?? []
      arr.push(t.label)
      byKey.set(k, arr)
    }
    const clusters = Array.from(byKey.values()).filter(g => g.length >= 2)

    result[cat] = { tags: tagsOut, clusters }
  }

  return NextResponse.json(result)
}
