import { notFound } from 'next/navigation'
import { addDays, format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { resolveRubric, type ScoringProfile } from '@/lib/scoring-profile'
import { sessionUtcWindow, todayPT } from '@/lib/pt-time'
import { weekStartFor, previousWeekStart, nextWeekStart } from '@/lib/week-dates'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import DeepDiveWorkspace, { type PickerTrade } from '@/components/deep-dive/DeepDiveWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f-]{36}$/i

/** "Oct 12 – 16", or "Sep 28 – Oct 2" across a month end. */
function weekRange(monday: string): string {
  const m = parseISO(monday), f = addDays(m, 4)
  return format(m, 'MMM') === format(f, 'MMM') ? `${format(m, 'MMM d')} – ${format(f, 'd')}` : `${format(m, 'MMM d')} – ${format(f, 'MMM d')}`
}

/**
 * Replay Review (was Deep Dive) — one trade at a time, exactly as it looked at
 * the fill, with the week's trades down the side.
 *
 * This page only decides WHICH week and trade. The list carries entry-time
 * facts and a yes/no for "you've made your call" — never the call itself, the
 * P&L or anything else about how a trade turned out, so Blind can show it as
 * is. Results come from /api/deep-dive/results, which the workspace asks for
 * only when the trader switches to Full review; the trade itself comes from
 * /api/deep-dive/trade, cut at the fill on the server.
 *
 *   ?id=<trade>   that trade, in its week (Game film's "Replay this trade")
 *   ?week=<Mon>   that week, first trade
 *   ?date=<day>   that day's week, first trade of the day (old Deep Dive links)
 */
export default async function ReplayPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; date?: string; week?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  // Private beta on the hosted site: for anyone not on the list this page does not exist.
  const { data: { user } } = await supabase.auth.getUser()
  if (!deepDiveAllowed(user?.email)) notFound()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose client, matching the other Review pages
  const db = supabase as any

  const { data: profRow } = await db
    .from('trader_profile').select('scoring_profile_json').eq('id', 'default').maybeSingle()
  const scoring = (profRow?.scoring_profile_json && typeof profRow.scoring_profile_json === 'object'
    ? profRow.scoring_profile_json : null) as ScoringProfile | null
  const usesOrderFlow = resolveRubric(scoring).usesOrderFlow

  // The week: the asked-for trade's, else ?week=, else ?date=, else the latest trade's.
  let selectedId = UUID.test(sp.id ?? '') ? sp.id! : null
  let anchor: string | null = null
  if (selectedId) {
    const { data } = await db.from('trades').select('entry_time').eq('id', selectedId).maybeSingle()
    if (data?.entry_time) anchor = todayPT(new Date(data.entry_time))
    else selectedId = null
  }
  const askedDate = DATE.test(sp.date ?? '') ? sp.date! : null
  if (!anchor) anchor = DATE.test(sp.week ?? '') ? sp.week! : askedDate
  if (!anchor) {
    const { data } = await db.from('trades').select('entry_time')
      .not('entry_time', 'is', null).order('entry_time', { ascending: false }).limit(1)
    anchor = data?.[0]?.entry_time ? todayPT(new Date(data[0].entry_time)) : todayPT()
  }
  const weekStart = weekStartFor(anchor!)
  // Monday 00:00 PT → Sunday 23:59:59 PT, so a Sunday-evening Globex trade still has a week.
  const from = sessionUtcWindow(weekStart).start
  const to = sessionUtcWindow(format(addDays(parseISO(weekStart), 6), 'yyyy-MM-dd')).end

  const listQuery = (cols: string) => db.from('trades').select(cols)
    .gte('entry_time', from).lte('entry_time', to)
    .order('entry_time', { ascending: true }).order('id', { ascending: true })
  let res = await listQuery('id, entry_time, symbol, direction, call:review_json->verdict->>call')
  if (res.error) res = await listQuery('id, entry_time, symbol, direction')   // review_json not migrated on this database
  const trades: PickerTrade[] = ((res.data ?? []) as { id: string; entry_time: string; symbol: string | null; direction: string | null; call?: string | null }[])
    .map(r => ({
      id: r.id, entryUtc: r.entry_time, symbol: r.symbol ?? '',
      direction: r.direction === 'short' ? 'short' : 'long',
      date: todayPT(new Date(r.entry_time)),
      called: !!r.call,
    }))

  const initialId = selectedId
    ?? (askedDate ? trades.find(t => t.date === askedDate)?.id : undefined)
    ?? trades[0]?.id ?? null
  const thisWeek = weekStartFor(todayPT())
  const next = nextWeekStart(weekStart)

  return (
    <DeepDiveWorkspace
      key={weekStart}
      trades={trades}
      initialId={initialId}
      usesOrderFlow={usesOrderFlow}
      week={{
        title: weekStart === thisWeek ? 'This week' : 'Week',
        range: weekRange(weekStart),
        prev: previousWeekStart(weekStart),
        next: next <= thisWeek ? next : null,
      }}
    />
  )
}
