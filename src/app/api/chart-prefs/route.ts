import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface PrefRow { key: string; value: unknown; updated_at?: string }

/**
 * GET /api/chart-prefs
 *
 * Returns all chart-prefs rows. The chart sync layer fetches this once on
 * first-ever mount per PC (gated by the `chart-prefs-migrated-v1` localStorage
 * flag) and hydrates localStorage from whatever Supabase has. After
 * migration, this endpoint isn't called again unless the user wipes the flag.
 */
export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('chart_prefs')
    .select('key, value, updated_at')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ entries: data ?? [] })
}

/**
 * POST /api/chart-prefs
 * Body: { entries: Array<{ key: string; value: unknown }> }
 *
 * Upserts each pair, bumping `updated_at` to now(). Two callers:
 *   1. The migration-baseline push (run once on THIS PC before the other PC
 *      ever sees the sync code), sending every `livechart-*` localStorage
 *      entry as a batch.
 *   2. The runtime sync layer, debounced per-key, sending a single
 *      `{key, value}` after every appearance-pref change or "Save chart view"
 *      click.
 *
 * Empty entries array is a no-op. Invalid keys (anything not starting with
 * `livechart-`) are rejected to prevent the table being used as a generic
 * KV — keep its purpose narrow.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const entries: PrefRow[] = body?.entries ?? []
  if (!Array.isArray(entries)) {
    return NextResponse.json({ error: 'entries must be an array' }, { status: 400 })
  }
  if (entries.length === 0) {
    return NextResponse.json({ ok: true, written: 0 })
  }
  // Narrow allow-list: only the keys the current LiveChart code actually
  // reads. Mirrors `isActiveChartPrefKey` in src/lib/chart-prefs.ts. Stops
  // legacy/cruft keys (livechart-prefs-v1, livechart-view-v2-*, etc.) from
  // landing in the table and being re-applied to the OTHER PC's localStorage
  // by its migration. Bump both sides together when LiveChart's key version
  // changes.
  for (const e of entries) {
    const k = e?.key
    if (typeof k !== 'string' || (k !== 'livechart-prefs-v2' && !k.startsWith('livechart-view-v3-'))) {
      return NextResponse.json({ error: `invalid key: ${k} (must be livechart-prefs-v2 or livechart-view-v3-*)` }, { status: 400 })
    }
  }

  const supabase: AnyClient = await createClient()
  const now = new Date().toISOString()
  const payload = entries.map(e => ({ key: e.key, value: e.value, updated_at: now }))
  const { error } = await supabase
    .from('chart_prefs')
    .upsert(payload, { onConflict: 'key' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, written: payload.length })
}
