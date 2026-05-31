import { readScidBars } from './scid-reader'
import { existsSync } from 'fs'
import { join, basename } from 'path'

// Sierra Chart data directory. Override via SIERRA_DATA_DIR in .env.local if
// your install differs. Reading .scid files is only possible because the
// journal's Next.js server runs locally on the same machine as Sierra.
export const SIERRA_DATA_DIR = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'

const UPSERT_CHUNK = 1000

export interface ImportScidResult {
  upserted: number
  tickCount: number
  symbol: string
  date: string
  scidFile: string
}

export type ImportScidOutcome =
  | { ok: true; result: ImportScidResult }
  | { ok: false; status: number; error: string; hint?: string }

interface ImportScidOpts {
  scidFile: string
  storeAs: string
  date: string // YYYY-MM-DD (UTC calendar day)
  priceDivisor?: number
  /** Insert a row into bar_imports (manual imports yes; background polls no). */
  writeHistory?: boolean
}

/**
 * Read one UTC calendar day of ticks from a .scid file, aggregate to 1-minute
 * bars, and upsert them into ohlcv_bars under `storeAs`. Shared by the manual
 * import route (writeHistory: true) and the background auto-import poll
 * (writeHistory: false, to avoid spamming the import-history table).
 *
 * `supabase` is the caller's request-scoped client so RLS/session apply.
 */
export async function importScidDay(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  opts: ImportScidOpts,
): Promise<ImportScidOutcome> {
  const priceDivisor = opts.priceDivisor ?? 100

  // Guard against path traversal — only allow a bare filename in the data dir.
  const safeName = basename(opts.scidFile)
  if (safeName !== opts.scidFile || !safeName.toLowerCase().endsWith('.scid')) {
    return { ok: false, status: 400, error: 'Invalid scidFile name' }
  }
  const fullPath = join(SIERRA_DATA_DIR, safeName)
  if (!existsSync(fullPath)) {
    return { ok: false, status: 404, error: `File not found: ${fullPath}` }
  }

  const startMs = Date.parse(`${opts.date}T00:00:00Z`)
  const endMs = startMs + 86_400_000

  let result
  try {
    result = readScidBars(fullPath, startMs, endMs, { priceDivisor })
  } catch (e) {
    console.error('[import-scid-day] parse failed:', e)
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'SCID parse failed' }
  }

  const { bars, tickCount, fileFirstMs, fileLastMs } = result
  if (bars.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `No ticks found for ${opts.date} in ${safeName}.`,
      hint: fileFirstMs && fileLastMs
        ? `File covers ${new Date(fileFirstMs).toISOString().slice(0, 10)} → ${new Date(fileLastMs).toISOString().slice(0, 10)}.`
        : undefined,
    }
  }

  const payload = bars.map(b => ({
    symbol: opts.storeAs,
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
      console.error('[import-scid-day] upsert failed at row', i, ':', error)
      return { ok: false, status: 500, error: `Upsert failed: ${error.message}` }
    }
    upserted += chunk.length
  }

  if (opts.writeHistory) {
    await supabase.from('bar_imports').insert({
      symbol: opts.storeAs,
      granularity: '1m',
      date_range_start: opts.date,
      date_range_end: opts.date,
      rows_inserted: upserted,
      rows_updated: null,
      source_filename: `${safeName} (SCID, ${tickCount.toLocaleString()} ticks)`,
    })
  }

  return { ok: true, result: { upserted, tickCount, symbol: opts.storeAs, date: opts.date, scidFile: safeName } }
}

/**
 * Build the symbol → source-.scid mapping from the most recent bar_imports.
 * Used by the auto-import poll to know which file feeds each charted symbol.
 * Mirrors the resolution in /api/bars/levels (regex over source_filename).
 */
export async function resolveSymbolScidMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<Map<string, string>> {
  const { data } = await supabase
    .from('bar_imports')
    .select('symbol, source_filename')
    .order('imported_at', { ascending: false })
    .limit(200)
  const map = new Map<string, string>()
  for (const row of (data ?? []) as { symbol: string; source_filename: string | null }[]) {
    if (!row.symbol || map.has(row.symbol)) continue
    const m = /([^\s/\\]+\.scid)/i.exec(row.source_filename ?? '')
    if (m) map.set(row.symbol, m[1])
  }
  return map
}
