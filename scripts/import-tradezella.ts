import { readFileSync } from 'fs'
import Papa from 'papaparse'
import { createClient } from '@supabase/supabase-js'
import {
  normalizeRow, emptyTagLookup, tagKey, TAG_CATEGORIES,
  type TZRow, type TagCategory, type NormalizedHistoricalTrade,
} from '../src/lib/tradezella-import'

// Load .env.local
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const CSV = process.argv[2] || 'C:\\Users\\lamed\\Downloads\\trades_20260528060442.csv'

async function main() {
  const text = readFileSync(CSV, 'utf8')
  const parsed = Papa.parse<TZRow>(text, { header: true, skipEmptyLines: true })
  const rows = parsed.data.filter(r => r['Open Date'])
  console.log(`Parsed ${rows.length} rows from ${CSV}`)

  // Seed the tag lookup with existing trade_tags (key → canonical label).
  const lookup = emptyTagLookup()
  const { data: existingTags } = await sb.from('trade_tags').select('category, label')
  for (const t of (existingTags ?? []) as { category: string; label: string }[]) {
    if (TAG_CATEGORIES.includes(t.category as TagCategory)) {
      lookup[t.category as TagCategory].set(tagKey(t.label), t.label)
    }
  }
  console.log(`Seeded ${existingTags?.length ?? 0} existing tags`)

  const newTags: Array<{ category: TagCategory; label: string }> = []
  const records: NormalizedHistoricalTrade[] = rows.map(r => normalizeRow(r, lookup, newTags))

  // Dedupe new tags + insert them so they appear in the tag library.
  const seen = new Set<string>()
  const uniqueNew = newTags.filter(t => {
    const k = `${t.category}|${tagKey(t.label)}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })
  console.log(`New tags to add: ${uniqueNew.length}`)
  if (uniqueNew.length) {
    // sort_order high so they sit after curated tags
    const payload = uniqueNew.map((t, i) => ({ category: t.category, label: t.label, sort_order: 1000 + i }))
    const { error } = await sb.from('trade_tags').upsert(payload, { onConflict: 'category,label', ignoreDuplicates: true })
    if (error) console.error('tag insert error:', error.message)
  }

  // Upsert historical_trades in chunks (idempotent on dedup_key).
  const CHUNK = 500
  let up = 0
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK)
    const { error } = await sb.from('historical_trades').upsert(chunk, { onConflict: 'dedup_key' })
    if (error) { console.error('upsert error at', i, ':', error.message); process.exit(1) }
    up += chunk.length
  }
  console.log(`Upserted ${up} historical_trades`)

  // Summary
  const { count } = await sb.from('historical_trades').select('*', { count: 'exact', head: true })
  console.log(`historical_trades now has ${count} rows`)
  const catCounts: Record<string, number> = {}
  for (const r of records) for (const c of TAG_CATEGORIES) {
    const v = r.tags_json[c]; if (Array.isArray(v) ? v.length : v) catCounts[c] = (catCounts[c] ?? 0) + 1
  }
  console.log('rows carrying each category:', JSON.stringify(catCounts))
}

main().catch(e => { console.error(e); process.exit(1) })
