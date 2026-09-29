import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import {
  valueArea, fromTuples, profileWindowMs, PROFILE_SESSIONS, PROFILE_TICK,
  type ProfileRow, type ProfileRowTuple, type ProfileSession,
} from '@/lib/volume-profile'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bars/profile?symbol=ESU6.CME&date=YYYY-MM-DD
 *   → { profile: Profile | null, eth: (Profile & { anchorMs }) | null }
 *   where Profile = { rows, tick, poc, vah, val, total, source }
 *
 * The session's TICK-TRUE volume profiles for the symbol's mini root:
 *   profile — RTH, 06:30–13:15 PT. The key predates `eth`, so it keeps its name.
 *   eth     — overnight, 15:00 PT the day before → 06:30. `anchorMs` is that
 *             06:30 boundary: the chart draws the profile ending there.
 *
 *   • Local build: computed on the spot from the .scid tick file — the machine
 *     already holds it, so there is nothing to wait for.
 *   • Hosted build: read from session_volume_profile, which the .scid feed
 *     publishes. Readable anonymously, so share links get it too.
 *
 * null means "no true profile for this session" — before it opens, a date older
 * than the feed's history, or the table not migrated yet. It never falls back
 * to a profile smeared from 1-minute bars: that version put the ES 2026-09-14
 * POC nine points from the real one, and a chart showing a confident wrong POC
 * is worse than one showing none. The chart hides its Profile toggle when both
 * are null, so nothing half-working reaches the screen.
 */
type Profile = { rows: ProfileRowTuple[]; tick: number; poc: number; vah: number; val: number; total: number; source: string }
type Profiles = Record<ProfileSession, Profile | null>

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol')
  const date = searchParams.get('date')
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 })
  }
  const root = chartSeriesRoot(symbol)
  const none: Profiles = { rth: null, eth: null }
  const respond = (p: Profiles) => NextResponse.json({
    profile: p.rth,
    eth: p.eth ? { ...p.eth, anchorMs: profileWindowMs('eth', date).endMs } : null,
  })
  // Recompute POC/VA rather than trust a stored summary: it is cheap, and it
  // keeps the chart's POC/VA consistent with the rows it is actually drawing.
  const build = (rows: ProfileRow[], tick: number, source: string): Profile | null => {
    const va = valueArea(rows)
    return va ? { rows: rows.map(r => [r.price, r.volume, r.ask, r.bid]), tick, ...va, source } : null
  }

  if (LOCAL_FEATURES_ENABLED) {
    try {
      // Imported lazily: fs-backed, and only meaningful where the tick files live.
      const [{ readScidVolumeAtPrice }, { contractFileForRoot }, { SIERRA_DATA_DIR }, { join }, { existsSync }] =
        await Promise.all([
          import('@/lib/scid-volume-profile'),
          import('@/lib/futures-contracts'),
          import('@/lib/import-scid-day'),
          import('path'),
          import('fs'),
        ])
      if (root !== 'ES' && root !== 'NQ') return respond(none)
      const file = contractFileForRoot(root, date)
      const path = file ? join(SIERRA_DATA_DIR, file) : null
      if (!path || !existsSync(path)) return respond(none)
      const tick = PROFILE_TICK[root] ?? 0.25
      const out: Profiles = { ...none }
      for (const session of PROFILE_SESSIONS) {
        const { startMs, endMs } = profileWindowMs(session, date)
        const { rows } = readScidVolumeAtPrice(path, startMs, endMs, { priceDivisor: 100, tick })
        out[session] = build(rows, tick, 'scid-local')
      }
      return respond(out)
    } catch {
      return respond(none)
    }
  }

  try {
    const supabase = await createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table is newer than the generated types
    const { data, error } = await (supabase as any)
      .from('session_volume_profile')
      .select('session, rows, tick, source')
      .eq('symbol', root)
      .eq('date', date)
      .in('session', PROFILE_SESSIONS)
    if (error || !Array.isArray(data)) return respond(none)
    const out: Profiles = { ...none }
    for (const row of data as Array<{ session: string; rows: ProfileRowTuple[]; tick: number | string; source: string }>) {
      if (row.session !== 'rth' && row.session !== 'eth') continue
      out[row.session] = build(fromTuples(row.rows), Number(row.tick), row.source)
    }
    return respond(out)
  } catch {
    return respond(none)
  }
}
