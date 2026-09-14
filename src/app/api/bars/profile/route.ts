import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { valueArea, fromTuples, PROFILE_RTH, PROFILE_TICK, type ProfileRowTuple } from '@/lib/volume-profile'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bars/profile?symbol=ESU6.CME&date=YYYY-MM-DD
 *   → { profile: { rows, tick, poc, vah, val, total, source } | null }
 *
 * The session's TICK-TRUE RTH volume profile for the symbol's mini root.
 *
 *   • Local build: computed on the spot from the .scid tick file — the machine
 *     already holds it, so there is nothing to wait for.
 *   • Hosted build: read from session_volume_profile, which the .scid feed
 *     publishes. Readable anonymously, so share links get it too.
 *
 * `profile: null` means "no true profile for this session" — before the open, a
 * date older than the feed's history, or the table not migrated yet. It never
 * falls back to a profile smeared from 1-minute bars: that version put the ES
 * 2026-09-14 POC nine points from the real one, and a chart showing a confident
 * wrong POC is worse than one showing none. The chart hides its Profile toggle
 * on null, so nothing half-working reaches the screen.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol')
  const date = searchParams.get('date')
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 })
  }
  const root = chartSeriesRoot(symbol)

  if (LOCAL_FEATURES_ENABLED) {
    try {
      // Imported lazily: fs-backed, and only meaningful where the tick files live.
      const [{ readScidVolumeAtPrice }, { contractFileForRoot }, { SIERRA_DATA_DIR }, { ptDateSodToUtcMs }, { join }, { existsSync }] =
        await Promise.all([
          import('@/lib/scid-volume-profile'),
          import('@/lib/futures-contracts'),
          import('@/lib/import-scid-day'),
          import('@/lib/pt-time'),
          import('path'),
          import('fs'),
        ])
      if (root !== 'ES' && root !== 'NQ') return NextResponse.json({ profile: null })
      const file = contractFileForRoot(root, date)
      const path = file ? join(SIERRA_DATA_DIR, file) : null
      if (!path || !existsSync(path)) return NextResponse.json({ profile: null })
      const tick = PROFILE_TICK[root] ?? 0.25
      const { rows } = readScidVolumeAtPrice(
        path,
        ptDateSodToUtcMs(date, PROFILE_RTH.startSec),
        ptDateSodToUtcMs(date, PROFILE_RTH.endSec),
        { priceDivisor: 100, tick },
      )
      const va = valueArea(rows)
      if (!va) return NextResponse.json({ profile: null })
      return NextResponse.json({ profile: { rows: rows.map(r => [r.price, r.volume, r.ask, r.bid]), tick, ...va, source: 'scid-local' } })
    } catch {
      return NextResponse.json({ profile: null })
    }
  }

  try {
    const supabase = await createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table is newer than the generated types
    const { data, error } = await (supabase as any)
      .from('session_volume_profile')
      .select('rows, tick, poc, vah, val, total_volume, source')
      .eq('symbol', root)
      .eq('date', date)
      .eq('session', 'rth')
      .maybeSingle()
    if (error || !data) return NextResponse.json({ profile: null })
    const rows = data.rows as ProfileRowTuple[]
    // Recompute rather than trust the stored summary blindly: it is cheap, and it
    // keeps the chart's POC/VA consistent with the rows it is actually drawing.
    const va = valueArea(fromTuples(rows))
    if (!va) return NextResponse.json({ profile: null })
    return NextResponse.json({ profile: { rows, tick: Number(data.tick), ...va, source: data.source } })
  } catch {
    return NextResponse.json({ profile: null })
  }
}
