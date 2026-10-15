/**
 * The founder's trades under the trade Score and the rule mistake tags — READ ONLY.
 *
 *   npx tsx scripts/trade-grade-report.ts [--from 2026-09-26]
 *
 * Reads their profile rules and trades from the PUBLIC project (service key
 * from .env.public-feed; nothing is written) and prints each trade's Score
 * (Entry · Exit) and the mistake tags the app WOULD add or take off, next to
 * the mistakes already on the trade — the dry run of POST /api/trades/rule-tags.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { readEntryRules } from '../src/lib/entry-rules.ts'
import { readRunnerRules } from '../src/lib/runner-rules.ts'
import { tradeGrade } from '../src/lib/trade-grade.ts'
import { mergeAutoMistakes, ruleMistakeTagsFor } from '../src/lib/rule-tags.ts'
import { includeFlowScoreInEntry, type ScoringProfile } from '../src/lib/scoring-profile.ts'

const FROM = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : '2026-09-26'

async function main() {
  const env: Record<string, string> = {}
  for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY)
  const { data: u } = await sb.auth.admin.listUsers({ perPage: 200 })
  const uid = u.users.find(x => x.email === 'edhasrage@gmail.com')?.id
  if (!uid) throw new Error('founder not found')
  const { data: prof } = await sb.from('trader_profile').select('scoring_profile_json').eq('user_id', uid).maybeSingle()
  const sp = (prof?.scoring_profile_json ?? {}) as ScoringProfile & Record<string, unknown>
  const entryRules = readEntryRules(sp.entry_rules), runnerRules = readRunnerRules(sp.runner_rules)
  const { data: trades, error } = await sb.from('trades').select('*').eq('user_id', uid).gte('entry_time', FROM).order('entry_time')
  if (error) throw new Error(error.message)
  let wouldWrite = 0, adds = 0, removes = 0, userKept = 0
  const perTag = new Map<string, number>()
  console.log(`${trades.length} trades since ${FROM} · ${entryRules.length} entry rules · ${runnerRules.length} runner rules\n`)
  for (const t of trades) {
    const g = tradeGrade(t, { entryRules, runnerRules, includeFlow: includeFlowScoreInEntry(sp) })
    const next = ruleMistakeTagsFor(t, entryRules, runnerRules)
    const plan = mergeAutoMistakes(t.tags_json?.mistakes, t.review_json?.auto_tags, next)
    const had = Array.isArray(t.tags_json?.mistakes) ? t.tags_json.mistakes as string[] : []
    const added = plan.mistakes.filter(m => !had.includes(m)), removed = had.filter(m => !plan.mistakes.includes(m))
    if (plan.changed) wouldWrite++
    adds += added.length; removes += removed.length
    userKept += had.filter(m => plan.mistakes.includes(m) && !plan.auto.includes(m)).length
    for (const a of added) perTag.set(a, (perTag.get(a) ?? 0) + 1)
    const when = new Date(t.entry_time).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles', hour12: false }).slice(0, 16)
    console.log(`${when} ${(t.direction ?? '').padEnd(5)} ${String(Math.round(t.pnl ?? 0)).padStart(6)}  Score ${String(g.score ?? '—').padStart(3)} (Entry ${g.entry ?? '—'} · Exit ${g.exit ?? '—'})`
      + `${had.length ? `  own mistakes [${had.join(', ')}]` : ''}${added.length ? `  + ${added.join(' + ')}` : ''}${removed.length ? `  − ${removed.join(' − ')}` : ''}`)
  }
  console.log(`\nWould write ${wouldWrite} trades: add ${adds} tags, take off ${removes}; the trader's own mistakes left alone: ${userKept}`)
  console.log('Tags it would add:', Object.fromEntries([...perTag.entries()].sort((a, b) => b[1] - a[1])))
}

main().catch(e => { console.error(e); process.exit(1) })
