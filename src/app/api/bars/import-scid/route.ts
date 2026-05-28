import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { readScidBars } from '@/lib/scid-reader'
import { readdirSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

// Sierra Chart data directory. Override via SIERRA_DATA_DIR in .env.local if
// your install differs. Reading .scid files is only possible because the
// journal's Next.js server runs locally on the same machine as Sierra.
const SIERRA_DATA_DIR = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'

const UPSERT_CHUNK = 1000

/**
 * GET — list available .scid files in the Sierra data directory (name + size),
 * for the import UI's source dropdown.
 */
export async function GET() {
  if (!existsSync(SIERRA_DATA_DIR)) {
    return NextResponse.json(
      { error: `Sierra data dir not found: ${SIERRA_DATA_DIR}. Set SIERRA_DATA_DIR in .env.local.`, files: [] },
      { status: 200 },
    )
  }
  try {
    const files = readdirSync(SIERRA_DATA_DIR)
      .filter(f => f.toLowerCase().endsWith('.scid'))
      .map(f => {
        const st = statSync(join(SIERRA_DATA_DIR, f))
        return { name: f, sizeBytes: st.size }
      })
      // Skip empty placeholder files (56-byte header-only)
      .filter(f => f.sizeBytes > 56)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
    return NextResponse.json({ files, dir: SIERRA_DATA_DIR })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'readdir failed', files: [] }, { status: 500 })
  }
}

/**
 * POST — import one day of bars from a .scid file.
 * Body: { scidFile, storeAs, date, priceDivisor? }
 *   scidFile:     filename within SIERRA_DATA_DIR (e.g., "NQM6.CME.scid")
 *   storeAs:      symbol to store bars under (e.g., "MNQM6.CME" — matches the
 *                 symbol on the trades you want to chart)
 *   date:         YYYY-MM-DD (UTC calendar day)
 *   priceDivisor: price scaling (default 100 for NQ/MNQ)
 */
export async function POST(req: Request) {
  const body = await req.json() as {
    scidFile?: string
    storeAs?: string
    date?: string
    priceDivisor?: number
  }
  const { scidFile, storeAs, date } = body
  const priceDivisor = body.priceDivisor ?? 100

  if (!scidFile) return NextResponse.json({ error: 'scidFile required' }, { status: 400 })
  if (!storeAs) return NextResponse.json({ error: 'storeAs (symbol) required' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }

  // Guard against path traversal — only allow a bare filename in the data dir.
  const safeName = basename(scidFile)
  if (safeName !== scidFile || !safeName.toLowerCase().endsWith('.scid')) {
    return NextResponse.json({ error: 'Invalid scidFile name' }, { status: 400 })
  }
  const fullPath = join(SIERRA_DATA_DIR, safeName)
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: `File not found: ${fullPath}` }, { status: 404 })
  }

  const startMs = Date.parse(`${date}T00:00:00Z`)
  const endMs = startMs + 86_400_000

  let result
  try {
    result = readScidBars(fullPath, startMs, endMs, { priceDivisor })
  } catch (e) {
    console.error('[bars/import-scid] parse failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'SCID parse failed' }, { status: 500 })
  }

  const { bars, tickCount, fileFirstMs, fileLastMs } = result
  if (bars.length === 0) {
    return NextResponse.json({
      error: `No ticks found for ${date} in ${safeName}.`,
      hint: fileFirstMs && fileLastMs
        ? `File covers ${new Date(fileFirstMs).toISOString().slice(0, 10)} → ${new Date(fileLastMs).toISOString().slice(0, 10)}.`
        : undefined,
    }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const payload = bars.map(b => ({
    symbol: storeAs,
    ts: b.ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }))

  let upserted = 0
  for (let i = 0; i < payload.length; i += UPSERT_CHUNK) {
    const chunk = payload.slice(i, i + UPSERT_CHUNK)
    const { error } = await supabase.from('ohlcv_bars').upsert(chunk, { onConflict: 'symbol,ts' })
    if (error) {
      console.error('[bars/import-scid] upsert failed at row', i, ':', error)
      return NextResponse.json({ error: `Upsert failed: ${error.message}`, partialUpserted: upserted }, { status: 500 })
    }
    upserted += chunk.length
  }

  await supabase.from('bar_imports').insert({
    symbol: storeAs,
    granularity: '1m',
    date_range_start: date,
    date_range_end: date,
    rows_inserted: upserted,
    rows_updated: null,
    source_filename: `${safeName} (SCID, ${tickCount.toLocaleString()} ticks)`,
  })

  return NextResponse.json({
    upserted,
    tickCount,
    symbol: storeAs,
    date,
    scidFile: safeName,
  })
}
