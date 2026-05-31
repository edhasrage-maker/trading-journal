import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { importTradezellaCsv } from '@/lib/import-tradezella-day'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

// Where Tradezella exports land on the user's machine. The export filename
// pattern is `trades_<timestamp>.csv`. Override via TRADEZELLA_DOWNLOADS_DIR
// in .env.local; defaults to the OS user's Downloads folder.
const TZ_DIR = process.env.TRADEZELLA_DOWNLOADS_DIR || join(homedir(), 'Downloads')

interface TzCsv { name: string; sizeBytes: number; mtimeMs: number }

/**
 * GET — list candidate Tradezella export CSVs in the downloads dir, newest
 * first. Used by the import UI's source dropdown (mirrors the SCID importer's
 * pattern). Returns `dir` so the UI can show where it's looking.
 */
export async function GET() {
  if (!existsSync(TZ_DIR)) {
    return NextResponse.json(
      { error: `Downloads dir not found: ${TZ_DIR}. Set TRADEZELLA_DOWNLOADS_DIR in .env.local.`, files: [], dir: TZ_DIR },
      { status: 200 },
    )
  }
  try {
    const files: TzCsv[] = readdirSync(TZ_DIR)
      .filter(f => /^trades_.*\.csv$/i.test(f) || /tradezella/i.test(f))
      .map(f => {
        const st = statSync(join(TZ_DIR, f))
        return { name: f, sizeBytes: st.size, mtimeMs: st.mtimeMs }
      })
      .filter(f => f.sizeBytes > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return NextResponse.json({ files, dir: TZ_DIR })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'readdir failed', files: [], dir: TZ_DIR }, { status: 500 })
  }
}

/**
 * POST — run the importer on a file in TZ_DIR.
 * Body: { file: "trades_20260528060442.csv", autoMerge?: boolean }
 *
 * autoMerge=true triggers a pre-import library cleanup that folds any
 * same-tagKey clusters in trade_tags (e.g. "Break & Retest" ↔ "Break And
 * Retest") into a single canonical label across both trades and
 * historical_trades. Idempotent — safe to run on every import.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const file: string | undefined = body?.file
  const autoMerge: boolean = body?.autoMerge === true
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })

  // Reject any path that escapes the configured dir.
  const safeName = basename(file)
  if (safeName !== file || !safeName.toLowerCase().endsWith('.csv')) {
    return NextResponse.json({ error: 'invalid filename' }, { status: 400 })
  }
  const fullPath = join(TZ_DIR, safeName)
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: `file not found: ${fullPath}` }, { status: 404 })
  }

  const supabase: AnyClient = await createClient()
  try {
    const result = await importTradezellaCsv(supabase, fullPath, { autoMerge })
    return NextResponse.json({ ok: true, file: safeName, ...result })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Import failed' },
      { status: 500 },
    )
  }
}
