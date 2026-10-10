import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveRubric, type ScoringProfile } from '@/lib/scoring-profile'
import { sessionUtcWindow, todayPT } from '@/lib/pt-time'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import DeepDiveWorkspace, { type PickerTrade } from '@/components/deep-dive/DeepDiveWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Deep Dive Review — one trade at a time, exactly as it looked at the fill.
 *
 * This page only decides WHICH trade: the picker lists a day's trades by entry
 * time, instrument and direction — nothing about how they turned out. The
 * workspace fetches the trade itself from /api/deep-dive/trade, which cuts the
 * data at the fill on the server.
 */
export default async function DeepDivePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; date?: string }>
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

  // The day to list: the selected trade's day, else ?date=, else the latest day with trades.
  let date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : null
  let selectedId = /^[0-9a-f-]{36}$/i.test(sp.id ?? '') ? sp.id! : null
  if (selectedId) {
    const { data } = await db.from('trades').select('entry_time').eq('id', selectedId).maybeSingle()
    if (data?.entry_time) date = todayPT(new Date(data.entry_time))
    else selectedId = null
  }
  if (!date) {
    const { data } = await db.from('trades').select('entry_time')
      .not('entry_time', 'is', null).order('entry_time', { ascending: false }).limit(1)
    date = data?.[0]?.entry_time ? todayPT(new Date(data[0].entry_time)) : todayPT()
  }
  const win = sessionUtcWindow(date!)
  const { data: rows } = await db.from('trades')
    .select('id, entry_time, symbol, direction')
    .gte('entry_time', win.start).lte('entry_time', win.end)
    .order('entry_time', { ascending: true }).order('id', { ascending: true })
  const trades: PickerTrade[] = ((rows ?? []) as { id: string; entry_time: string; symbol: string | null; direction: string | null }[])
    .map(r => ({ id: r.id, entryUtc: r.entry_time, symbol: r.symbol ?? '', direction: r.direction === 'short' ? 'short' : 'long' }))

  return (
    <DeepDiveWorkspace
      date={date!}
      trades={trades}
      initialId={selectedId ?? trades[0]?.id ?? null}
      usesOrderFlow={usesOrderFlow}
    />
  )
}
