import { createClient } from '@/lib/supabase/server'
import TagMergeClient from '@/components/settings/TagMergeClient'
import { normalizeTagArray, type TagCategory, type TradeTag } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000
const CATEGORIES: TagCategory[] = [
  'setups', 'confluences', 'order_flow', 'trade_management', 'day_type', 'mistakes', 'emotions',
]

async function tallyUsage(
  supabase: AnyClient,
  table: 'trades' | 'historical_trades',
  counts: Map<string, number>,
): Promise<void> {
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from(table)
      .select('id, tags_json')
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = (data ?? []) as { tags_json: Record<string, unknown> | null }[]
    for (const r of rows) {
      const tj = r.tags_json ?? {}
      for (const cat of CATEGORIES) {
        for (const label of normalizeTagArray(tj[cat])) {
          if (!label) continue
          const key = `${cat}|${label}`
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
    }
    if (rows.length < PAGE) break
  }
}

export default async function TagsSettingsPage() {
  const supabase: AnyClient = await createClient()

  const { data: tagsRaw } = await supabase
    .from('trade_tags')
    .select('*')
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true }) as { data: TradeTag[] | null }
  const tags = tagsRaw ?? []

  const counts = new Map<string, number>()
  await tallyUsage(supabase, 'trades', counts)
  await tallyUsage(supabase, 'historical_trades', counts)
  const usage: Record<string, number> = {}
  for (const [k, v] of counts) usage[k] = v

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white">Tag Management</h1>
        <p className="text-sm text-gray-500 mt-1">
          Add a tag with <span className="text-gray-400">+ Add tag</span>, merge
          near-duplicates so analytics groups them correctly, or remove one with
          the <span className="text-gray-400">✕</span> on its chip. Merge and
          remove rewrite every native + imported trade that uses the tag.
        </p>
      </header>
      <TagMergeClient tags={tags} usage={usage} />
    </div>
  )
}
