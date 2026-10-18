import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { deepDiveAllowed } from '@/lib/deep-dive-access'

export const dynamic = 'force-dynamic'

/**
 * Deep Dive is now Replay Review (/review/replay). Old links and bookmarks
 * forward there with the same trade, day or week. Same private beta: anyone
 * not on the list still gets a page that does not exist.
 */
export default async function DeepDiveRedirect({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; date?: string; week?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!deepDiveAllowed(user?.email)) notFound()
  const q = new URLSearchParams()
  for (const k of ['id', 'date', 'week'] as const) if (typeof sp[k] === 'string' && sp[k]) q.set(k, sp[k]!)
  const qs = q.toString()
  redirect(`/review/replay${qs ? `?${qs}` : ''}`)
}
