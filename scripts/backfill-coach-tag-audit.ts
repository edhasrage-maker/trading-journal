/**
 * Seed coach_tag_audit from assisted fills already on a trader's trades
 * (review_json.assist_fill — the Oct 26–27 auto-fill was the first), so their
 * first weekly check has the coach's tags in it. One trader per run.
 *
 *   npx tsx scripts/backfill-coach-tag-audit.ts --user=<uid>            # dry run (prod)
 *   npx tsx scripts/backfill-coach-tag-audit.ts --user=<uid> --apply
 *   --env-file=<path>   credentials file (default .env.public-feed)
 *
 * Per trade with an assist_fill:
 *   - every tag in assist_fill.set.tags → a row, source 'assist', applied,
 *     with its H/M/L and reason from assist_fill.conf. Never counted and so
 *     skipped: day types (copied from the trader's own day labels), emotions.
 *   - the trade's other tags → 'before' rows (the trader's own; never counted
 *     as tags the coach missed). Rule tags (review_json.auto_tags) are left out.
 * A trade that already has rows is skipped, so a re-run writes nothing new.
 * Writes nothing to trades. Service role: user_id is set explicitly.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { normalizeTagArray } from '../src/lib/supabase/types'
import { NEVER_AUDITED } from '../src/lib/coach-tag-audit'

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const apply = process.argv.includes('--apply')
const user = arg('user')
if (!user || !/^[0-9a-f-]{36}$/i.test(user)) { console.error('--user=<uid> required'); process.exit(1) }
for (const line of readFileSync(arg('env-file') ?? '.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!)
const pt = (iso: string) => new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles', hour12: false }).replace(',', '')

interface Trade { id: string; entry_time: string; tags_json: Record<string, unknown> | null; review_json: { auto_tags?: unknown; assist_fill?: { at?: string; set?: { tags?: Record<string, unknown> }; conf?: Record<string, string> } } | null }

async function main() {
  const trades: Trade[] = []
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from('trades').select('id, entry_time, tags_json, review_json')
      .eq('user_id', user).not('review_json->assist_fill', 'is', null)
      .order('entry_time').order('id').range(p * 1000, p * 1000 + 999)
    if (error) throw error
    trades.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  const { data: have, error: he } = await sb.from('coach_tag_audit').select('trade_id').eq('user_id', user)
  if (he && !(he.code === 'PGRST205' && !apply)) throw he
  if (he) console.log('(coach_tag_audit not set up yet — previewing only)\n')
  const seeded = new Set((have ?? []).map((r: { trade_id: string }) => r.trade_id))

  const rows: Record<string, unknown>[] = []
  let assist = 0, before = 0, skippedDay = 0, skippedTrades = 0
  const conf = { H: 0, M: 0, L: 0 } as Record<string, number>
  for (const t of trades) {
    const af = t.review_json?.assist_fill
    const set = af?.set?.tags ?? {}
    if (seeded.has(t.id)) { skippedTrades++; continue }
    const at = af?.at ?? new Date().toISOString()
    const auto = normalizeTagArray(t.review_json?.auto_tags)
    const picked = new Set<string>()
    const line: string[] = []
    for (const [category, v] of Object.entries(set)) {
      for (const label of normalizeTagArray(v)) {
        const why = af?.conf?.[`${category}:${label}`] ?? ''
        if (NEVER_AUDITED.has(category) || /own day label/i.test(why)) { skippedDay++; continue }
        const c = (/^([HML]):/.exec(why)?.[1] ?? null) as 'H' | 'M' | 'L' | null
        picked.add(`${category}|${label}`)
        rows.push({ user_id: user, trade_id: t.id, category, label, source: 'assist', applied: true, conf: c, reason: why.replace(/^[HML]:\s*/, '') || null, proposed_at: at })
        assist++; if (c) conf[c]++
        line.push(`${label} (${c ?? '?'})`)
      }
    }
    const mine: string[] = []
    for (const [category, v] of Object.entries(t.tags_json ?? {})) {
      if (NEVER_AUDITED.has(category)) continue
      for (const label of normalizeTagArray(v)) {
        if (!label || picked.has(`${category}|${label}`) || (category === 'mistakes' && auto.includes(label))) continue
        rows.push({ user_id: user, trade_id: t.id, category, label, source: 'before', applied: false, proposed_at: at })
        before++; mine.push(label)
      }
    }
    console.log(`${pt(t.entry_time)}  coach: ${line.join(', ') || '—'}${mine.length ? `  | yours: ${mine.join(', ')}` : ''}`)
  }
  console.log(`\n${trades.length} trades with an assisted fill · ${skippedTrades} already seeded`)
  console.log(`${assist} coach tags (H ${conf.H} / M ${conf.M} / L ${conf.L}) · ${before} of your own · ${skippedDay} day types left out`)
  if (!apply) { console.log('\nDRY RUN — nothing written'); return }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('coach_tag_audit').upsert(rows.slice(i, i + 500), { onConflict: 'trade_id,category,label,source', ignoreDuplicates: true })
    if (error) throw error
  }
  console.log(`\nWROTE ${rows.length} rows to coach_tag_audit`)
}

main().catch(e => { console.error(e); process.exit(1) })
