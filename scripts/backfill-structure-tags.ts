/**
 * Apply the 5m follow/fade structure confluence to every trade that already
 * carries a decided `structure_5m_regime`.
 *
 * Usage:
 *   npx tsx scripts/backfill-structure-tags.ts            # dry run
 *   npx tsx scripts/backfill-structure-tags.ts --write
 *
 * WHY THIS IS A BACKFILL AND NOT A SUGGESTION. `followFade(direction, regime)`
 * is exact arithmetic over two stored fields — it is not a model guess, and the
 * architecture's rule is deterministic-means-fact. But the only thing that ever
 * applied it was /api/trades/suggest-tags, which offers it as an accept-to-add
 * chip requiring a click per trade. The result: thousands of trades held the
 * answer and stayed untagged.
 *
 * Only a decided bull/bear regime produces a tag. neutral / insufficient-data
 * produce nothing — precision over recall, matching the route this mirrors.
 *
 * Writes are scoped to the owner's user_id: prod is multi-tenant and the
 * service-role key bypasses RLS, so the scope is applied explicitly rather than
 * assumed. Existing tags are merged, never replaced, and a trade that already
 * carries either structure label is left alone.
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { followFade, type Regime } from '../src/lib/market-structure.ts'

for (const line of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const OWNER_PREFIX = 'fa3fb352'
const CATEGORY = 'confluences'
/** Must match /api/trades/suggest-tags exactly — these are the detector's
 *  canonical labels, and a near-duplicate casing also exists in the library. */
const STRUCTURE_TAG: Record<'follow' | 'fade', string> = {
  follow: 'Follow LTF structure',
  fade: 'Fade LTF structure',
}

const write = process.argv.slice(2).includes('--write')
const PAGE = 1000

interface DayRow { id: string; user_id: string }
interface TradeRow {
  id: string
  trading_day_id: string
  direction: 'long' | 'short' | null
  structure_5m_regime: Regime | null
  tags_json: Record<string, string[] | string> | null
}
interface TagRow { user_id: string; category: string; label: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(sb: any, table: string, cols: string): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from(table).select(cols)
      .order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = data as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

const asArray = (v: string[] | string | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(
    process.env.PUBLIC_SUPABASE_URL!,
    process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
  )

  const days = await fetchAll<DayRow>(sb, 'trading_days', 'id, user_id')
  const ownerDays = new Set(days.filter(d => d.user_id?.startsWith(OWNER_PREFIX)).map(d => d.id))

  // The labels must already exist in the owner's library. The detector selects
  // from the trader's vocabulary; it never creates it.
  const tags = await fetchAll<TagRow>(sb, 'trade_tags', 'user_id, category, label')
  const owned = new Set(
    tags.filter(t => t.user_id?.startsWith(OWNER_PREFIX)).map(t => `${t.category}::${t.label}`))
  const missing = Object.values(STRUCTURE_TAG).filter(l => !owned.has(`${CATEGORY}::${l}`))
  if (missing.length > 0) {
    console.error(`Missing from the owner library, refusing to run: ${missing.join(', ')}`)
    process.exit(1)
  }

  const trades = (await fetchAll<TradeRow>(sb, 'trades',
    'id, trading_day_id, direction, structure_5m_regime, tags_json'))
    .filter(t => ownerDays.has(t.trading_day_id))

  let follow = 0, fade = 0, already = 0, undecided = 0, noRegime = 0, updated = 0, errors = 0
  const pending: { id: string; tags: Record<string, string[] | string> }[] = []

  for (const t of trades) {
    if (!t.structure_5m_regime || !t.direction) { noRegime++; continue }
    const ff = followFade(t.direction, t.structure_5m_regime)
    if (ff !== 'follow' && ff !== 'fade') { undecided++; continue }
    const label = STRUCTURE_TAG[ff]

    const existing = asArray(t.tags_json?.[CATEGORY])
    // Either structure label already present → the trader (or a prior run)
    // has spoken; do not add a second one.
    if (existing.some(l => l === STRUCTURE_TAG.follow || l === STRUCTURE_TAG.fade)) { already++; continue }

    if (ff === 'follow') follow++; else fade++
    pending.push({ id: t.id, tags: { ...(t.tags_json ?? {}), [CATEGORY]: [...existing, label] } })
  }

  console.log(`\n${write ? 'WRITE' : 'DRY RUN'} — owner trades ${trades.length}`)
  console.log('='.repeat(58))
  console.log(`  no regime / no direction   ${noRegime}`)
  console.log(`  regime undecided (neutral) ${undecided}`)
  console.log(`  already has a structure tag ${already}`)
  console.log(`  WOULD TAG                  ${pending.length}  (follow ${follow}, fade ${fade})`)

  if (!write) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to apply.\n')
    return
  }

  for (const p of pending) {
    const { error } = await sb.from('trades').update({ tags_json: p.tags }).eq('id', p.id)
    if (error) { errors++; if (errors <= 5) console.error(`  ! ${p.id}: ${error.message}`) }
    else updated++
    if (updated % 500 === 0 && updated > 0) console.log(`  …${updated}`)
  }
  console.log(`\nUpdated ${updated} trades${errors ? `, ${errors} errors` : ''}.\n`)
}

main().catch(err => { console.error(err); process.exit(1) })
