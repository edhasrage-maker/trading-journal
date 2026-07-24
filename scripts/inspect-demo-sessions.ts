/** READ-ONLY. Dumps the demo account's recent sessions so seeded prep notes can
 *  be written to match what the charts and numbers actually show. Writes nothing. */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = readFileSync('.env.public-feed', 'utf8')
const pick = (re: RegExp) => (env.split(/\r?\n/).find(l => re.test(l))?.split('=').slice(1).join('=').trim() ?? '')
  .replace(/^["']|["']$/g, '')
const db = createClient(pick(/SUPABASE_URL/), pick(/SERVICE_ROLE/), { auth: { persistSession: false } })

const DEMO_EMAIL = 'demo@tapescore.app'

async function main() {
  const { data: list } = await db.auth.admin.listUsers()
  const demo = (list?.users ?? []).find(u => (u.email ?? '').toLowerCase() === DEMO_EMAIL)!

  const { data: dayRows } = await db.from('trading_days')
    .select('id, date, day_types, day_type, eod_pnl, eod_notes')
    .eq('user_id', demo.id).order('date', { ascending: false })
  const days = (dayRows ?? []) as {
    id: string; date: string; day_types: string[] | null; day_type: string | null
    eod_pnl: number | null; eod_notes: string | null
  }[]

  for (const d of days) {
    const { data: ctxRow } = await db.from('market_context')
      .select('symbol, rvol, adr, atr_1m, day_range, pdh, pdl, onh, onl, ibh, ibl')
      .eq('trading_day_id', d.id).maybeSingle()
    const c = ctxRow as Record<string, number | string | null> | null

    const { data: tradeRows } = await db.from('trades')
      .select('direction, pnl, entry_time, symbol, tags_json')
      .eq('trading_day_id', d.id).order('entry_time')
    const trades = (tradeRows ?? []) as {
      direction: string | null; pnl: number | null; entry_time: string | null
      symbol: string | null; tags_json: Record<string, string[]> | null
    }[]

    const longs = trades.filter(t => t.direction === 'long').length
    const shorts = trades.filter(t => t.direction === 'short').length
    const net = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const setups = new Set<string>()
    for (const t of trades) for (const s of (t.tags_json?.setups ?? [])) setups.add(s)

    const dr = c?.day_range as number | null
    const adr = c?.adr as number | null
    console.log(
      `\n${d.date}  types=[${(d.day_types ?? [d.day_type]).filter(Boolean).join(', ')}]  eod_pnl=${d.eod_pnl ?? '—'}`
      + `\n   trades ${trades.length} (${longs}L/${shorts}S) net ${net.toFixed(0)}  setups: ${[...setups].join(', ') || '—'}`
      + `\n   ctx: sym=${c?.symbol ?? '—'} rvol=${c?.rvol ?? '—'} adr=${adr ?? '—'} atr=${c?.atr_1m ?? '—'} dayRange=${dr ?? '—'}`
      + ` pdh=${c?.pdh ?? '—'} pdl=${c?.pdl ?? '—'} onh=${c?.onh ?? '—'} onl=${c?.onl ?? '—'}`,
    )
  }
}

main().catch(e => { console.error(e); process.exit(1) })
