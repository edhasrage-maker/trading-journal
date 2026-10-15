/**
 * Bring the app's rule mistake tags up to date on a trader's trades
 * (src/lib/rule-tags.ts says which; this reads and writes). Server only,
 * through the CALLER's session client — RLS confines it to their own rows.
 *
 * Called by POST /api/trades/rule-tags: for the trades on a page once their
 * entry snapshots are in, and for all of a trader's trades after they change
 * their rules in Settings.
 *
 * Writes are read-merge: the row is read again just before the write and only
 * `tags_json.mistakes` and `review_json.auto_tags` change — every other tag,
 * the Score, the snapshot and the verdict stay as they are. A trade whose
 * tags already match is not written at all.
 */
import { loadTapeScoreSettings } from '@/lib/day-stats-server'
import { allRuleMistakeTags, mergeAutoMistakes, ruleMistakeTagsFor, type RuleTagTrade } from '@/lib/rule-tags'
import { ensureTag, alphabetizeTags } from '@/lib/tag-library-server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const COLS = 'id, entry_time, direction, symbol, entry_price, tp1_price, entry_atr_1m, exits_json, tags_json, review_json'
const PAGE = 1000

type Row = RuleTagTrade & { id: string; tags_json: Record<string, unknown> | null; review_json: Record<string, unknown> | null }

export interface RuleTagsResult { checked: number; changed: number; tags: Record<string, string[]> }

/**
 * `ids` = just these trades; omitted = every trade on or after the earliest
 * rule start date, plus any trade still carrying app tags (a rule switched off
 * or removed takes its tags with it).
 */
export async function applyRuleTags(supabase: AnyClient, ids?: string[]): Promise<RuleTagsResult> {
  const { entryRules, runnerRules } = await loadTapeScoreSettings(supabase)
  const rows: Row[] = []
  if (ids) {
    if (!ids.length) return { checked: 0, changed: 0, tags: {} }
    const { data, error } = await supabase.from('trades').select(COLS).in('id', ids)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as Row[]))
  } else {
    const froms = [...entryRules, ...runnerRules].filter(r => r.on).map(r => r.from).sort()
    const seen = new Set<string>()
    const pull = async (q: (from: number) => Promise<{ data: Row[] | null; error: { message: string } | null }>) => {
      for (let p = 0; ; p++) {
        const { data, error } = await q(p * PAGE)
        if (error) throw new Error(error.message)
        for (const r of data ?? []) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r) }
        if ((data ?? []).length < PAGE) break
      }
    }
    if (froms.length) {
      // UTC midnight of the first start date = the evening before in PT, so the whole first day is in
      await pull(from => supabase.from('trades').select(COLS).gte('entry_time', froms[0]).order('entry_time').order('id').range(from, from + PAGE - 1))
    }
    await pull(from => supabase.from('trades').select(COLS).not('review_json->auto_tags', 'is', null).order('entry_time').order('id').range(from, from + PAGE - 1))
  }

  // The library entries come first, so every tag the app puts on a trade is one the picker shows.
  const libraryTags = allRuleMistakeTags(entryRules, runnerRules)
  let created = false
  for (const label of libraryTags) {
    try { created = (await ensureTag(supabase, 'mistakes', label, { alphabetize: false })).created || created } catch (e) { console.error('[rule-tags] library', label, e) }
  }
  if (created) await alphabetizeTags(supabase, 'mistakes')

  let changed = 0
  const tags: Record<string, string[]> = {}
  for (const r of rows) {
    const next = ruleMistakeTagsFor(r, entryRules, runnerRules)
    const plan = mergeAutoMistakes(r.tags_json?.mistakes, r.review_json?.auto_tags, next)
    tags[r.id] = plan.auto
    if (!plan.changed) continue
    // read-merge on the row as it is NOW
    const { data: fresh, error: re } = await supabase.from('trades').select('id, tags_json, review_json').eq('id', r.id).maybeSingle()
    if (re || !fresh) continue
    const now = mergeAutoMistakes(fresh.tags_json?.mistakes, fresh.review_json?.auto_tags, next)
    if (!now.changed) continue
    const tagsJson = { ...(fresh.tags_json ?? {}) } as Record<string, unknown>
    if (now.mistakes.length) tagsJson.mistakes = now.mistakes
    else delete tagsJson.mistakes
    const reviewJson = { ...(fresh.review_json ?? {}) } as Record<string, unknown>
    if (now.auto.length) reviewJson.auto_tags = now.auto
    else delete reviewJson.auto_tags
    const { error: we } = await supabase.from('trades').update({ tags_json: tagsJson, review_json: reviewJson }).eq('id', r.id)
    if (we) { console.error('[rule-tags] write', r.id, we.message); continue }
    tags[r.id] = now.auto
    changed++
  }
  return { checked: rows.length, changed, tags }
}
