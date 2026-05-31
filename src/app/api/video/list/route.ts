import { NextResponse } from 'next/server'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

export const OBS_RECORDINGS_DIR = process.env.OBS_RECORDINGS_DIR || 'D:\\obs-studio\\Videos'

/**
 * GET /api/video/list — list MP4/MKV/MOV recordings in OBS_RECORDINGS_DIR
 * sorted by mtime descending (most recent first). Mirrors the
 * /api/bars/import-scid GET that powers the SCID source dropdown.
 *
 * Recordings are processed locally; the file path never leaves the user's
 * machine. The dropdown is the only place a filename can be chosen — the
 * commentary route validates against this list via basename.
 */
export async function GET() {
  if (!existsSync(OBS_RECORDINGS_DIR)) {
    return NextResponse.json(
      {
        error: `OBS recordings dir not found: ${OBS_RECORDINGS_DIR}. Set OBS_RECORDINGS_DIR in .env.local.`,
        files: [],
        dir: OBS_RECORDINGS_DIR,
      },
      { status: 200 },
    )
  }
  try {
    const files = readdirSync(OBS_RECORDINGS_DIR)
      .filter(f => /\.(mp4|mkv|mov)$/i.test(f))
      .map(f => {
        const st = statSync(join(OBS_RECORDINGS_DIR, f))
        return { name: f, sizeBytes: st.size, mtimeMs: st.mtimeMs }
      })
      .filter(f => f.sizeBytes > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return NextResponse.json({ files, dir: OBS_RECORDINGS_DIR })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'readdir failed', files: [], dir: OBS_RECORDINGS_DIR },
      { status: 500 },
    )
  }
}
