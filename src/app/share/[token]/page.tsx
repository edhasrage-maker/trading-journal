import { createClient } from '@/lib/supabase/server'
import SharedDayView from './SharedDayView'
import type { Trade, TradingDay } from '@/lib/supabase/types'
import type { ChartPrefs } from '@/components/charts/LiveChart'

export const dynamic = 'force-dynamic'

/**
 * Per-share preview card. Without this the link unfurls to the generic branded
 * opengraph-image.png from the root layout — the same picture for every session
 * anyone shares, which tells a recipient nothing about what they're being sent.
 *
 * The image is the day's own saved chart: the Review page's chart first
 * (`eod_chart_screenshot_url` — what the trader was actually looking at when
 * they wrote the review), falling back to the prep chart, and finally to the
 * brand card when the day has neither. Days reviewed on the LIVE chart rather
 * than an uploaded screenshot legitimately have neither, so the fallback is a
 * normal outcome, not a failure.
 *
 * Screenshots live in a private bucket, so the path is signed through the same
 * `share-sign` Edge Function the page body uses. Note the signature is
 * time-limited: scrapers (Slack, iMessage, Twitter) fetch and cache the image
 * at unfurl time, so a link pasted today previews correctly, but a re-scrape
 * after the signature expires falls back. That is the right trade — the
 * alternative is making trade screenshots publicly readable.
 */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const base = { title: 'Shared session — TapeScore' }
  try {
    const { token } = await params
    const supabase = await createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc('get_shared_day', { p_token: token })
    const day = (data?.day ?? null) as TradingDay | null
    if (!day) return base

    await signSharedScreenshots(token, day, [])
    const image = day.eod_chart_screenshot_url || day.chart_screenshot_url
    if (!image || !/^https?:\/\//i.test(image)) return base

    const title = `Session review — ${day.date}`
    return {
      ...base,
      openGraph: { title, images: [{ url: image }] },
      twitter: { card: 'summary_large_image' as const, title, images: [image] },
    }
  } catch {
    // Never let preview generation break the page itself.
    return base
  }
}

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
