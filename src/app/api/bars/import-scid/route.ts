import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { importScidDay, SIERRA_DATA_DIR } from '@/lib/import-scid-day'
import { readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

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
        return { name: f, sizeBytes: st.size, mtimeMs: st.mtimeMs }
      })
      // Skip empty placeholder files (56-byte header-only)
      .filter(f => f.sizeBytes > 56)
      // Most-recently-written first: the live front-month contract Sierra is
      // actively appending to has the newest mtime, so it lands on top.
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
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

  if (!scidFile) return NextResponse.json({ error: 'scidFile required' }, { status: 400 })
  if (!storeAs) return NextResponse.json({ error: 'storeAs (symbol) required' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const outcome = await importScidDay(supabase, {
    scidFile,
    storeAs,
    date,
    priceDivisor: body.priceDivisor,
    writeHistory: true,
  })
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error, hint: outcome.hint }, { status: outcome.status })
  }
  return NextResponse.json(outcome.result)
}
