import { createClient } from '@/lib/supabase/server'
import SharedDayView from './SharedDayView'
import type { Trade, TradingDay } from '@/lib/supabase/types'
import type { ChartPrefs } from '@/components/charts/LiveChart'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Shared session — TapeScore' }

/**
 * Replace private-bucket screenshot PATHS on the shared day + trades with signed
 * URLs minted by the `share-sign` Edge Function. Mutates in place. Never throws —
 * on any failure the paths are left as-is (they just won't render), so the rest
 * of the shared view (chart, trades, tags, notes) always works.
 */
async function signSharedScreenshots(
  token: string,
  day: TradingDay | null,
  trades: Trade[],
): Promise<void> {
  const isPath = (v: unknown): v is string =>
    typeof v === 'string' && v !== '' && !/^https?:\/\//i.test(v)
  const anyPath =
    isPath(day?.chart_screenshot_url) ||
    isPath(day?.eod_chart_screenshot_url) ||
    trades.some(t => isPath(t.screenshot_url))
  if (!anyPath) return

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  let signed: Record<string, string> = {}
  try {
    const res = await fetch(`${base}/functions/v1/share-sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anon ? { Authorization: `Bearer ${anon}`, apikey: anon } : {}),
      },
      body: JSON.stringify({ token }),
      cache: 'no-store',
    })
    if (res.ok) signed = ((await res.json())?.signed ?? {}) as Record<string, string>
  } catch {
    return // graceful: leave paths as-is
  }

  const resolve = (v: string | null | undefined): string | null =>
    isPath(v) && signed[v] ? signed[v] : (v ?? null)
  if (day) {
    day.chart_screenshot_url = resolve(day.chart_screenshot_url)
    day.eod_chart_screenshot_url = resolve(day.eod_chart_screenshot_url)
  }
  for (const t of trades) t.screenshot_url = resolve(t.screenshot_url)
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = await createClient()
  // Token-gated read (SECURITY DEFINER RPC) — returns only this day's data, or
  // null when the token is invalid / revoked / expired. anon-callable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any
  const { data } = await db.rpc('get_shared_day', { p_token: token })

  const day = (data?.day ?? null) as TradingDay | null
  const trades = (data?.trades ?? []) as Trade[]
  const chartPrefs = (data?.chart_prefs ?? null) as Partial<ChartPrefs> | null

  // Trade/day screenshots are private-bucket storage paths; an anon visitor
  // can't sign them under folder RLS. The `share-sign` Edge Function validates
  // the token and signs the owner's paths with the service role (which lives in
  // Supabase's Edge env, not on Vercel). Degrades gracefully — if the function
  // isn't deployed or errors, screenshots simply don't render (everything else
  // does), and legacy absolute http URLs pass through untouched.
  await signSharedScreenshots(token, day, trades)

  if (!data || !day) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/tapescore-mark.svg" alt="TapeScore" className="h-10 w-10 mx-auto mb-4" />
          <h1 className="text-lg font-semibold text-white">This link isn&apos;t available</h1>
          <p className="text-gray-400 text-sm mt-2">
            The review link is invalid, has expired, or was revoked. Ask the trader for a fresh one.
          </p>
        </div>
      </div>
    )
  }

  return <SharedDayView day={day} trades={trades} chartPrefs={chartPrefs} />
}
