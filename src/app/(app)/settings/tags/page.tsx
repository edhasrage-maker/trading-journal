import { createClient } from '@/lib/supabase/server'
import TagMergeClient from '@/components/settings/TagMergeClient'
import { normalizeTagArray, type TradeTag } from '@/lib/supabase/types'
import { BUILTIN_TAG_CATEGORIES, resolveTagCategories, type TagCategoryDef } from '@/lib/tag-categories'
import { categoryKeysInUse, readCategoryPrefs } from '@/lib/tag-categories-server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000

async function tallyUsage(
  supabase: AnyClient,
  table: 'trades' | 'historical_trades',
  categories: readonly string[],
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
      for (const cat of categories) {
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

  // The category list is the trader's own now (Pt 16): built-ins they haven't
  // removed, plus any axis they added. Usage is tallied over exactly that list
  // so a custom category's chips carry real counts.
  const prefs = await readCategoryPrefs(supabase)
  const categories = resolveTagCategories(prefs, await categoryKeysInUse(supabase))
  const hiddenKeys = new Set(prefs.hidden ?? [])
  const hidden: TagCategoryDef[] = BUILTIN_TAG_CATEGORIES.filter(c => hiddenKeys.has(c.key)).map(c => ({ ...c }))

  const counts = new Map<string, number>()
  const keys = categories.map(c => c.key)
  await tallyUsage(supabase, 'trades', keys, counts)
  await tallyUsage(supabase, 'historical_trades', keys, counts)
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
        <p className="text-sm text-gray-500 mt-2">
          Categories are yours too — add your own (say <span className="text-gray-400">4h Candle Shape</span>)
          and remove any you don&apos;t use.
        </p>
      </header>
      <TagMergeClient tags={tags} usage={usage} categories={categories} hidden={hidden} />
    </div>
  )
}
