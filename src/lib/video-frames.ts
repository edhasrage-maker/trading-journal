import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { basename } from 'path'
import sharp from 'sharp'

/**
 * Thin wrappers around ffprobe + ffmpeg for extracting a single JPEG frame at a
 * given offset and reading the recording's start time. Used by the EOD video-
 * commentary route to align frames with each trade's fill timestamp.
 *
 * Binary paths fall back to PATH lookup — override via FFMPEG_BIN / FFPROBE_BIN
 * in .env.local if the binaries live somewhere unusual.
 */
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe'

export interface VideoInfo {
  /** Wall-clock instant the recording began (epoch ms). */
  creationTimeMs: number
  /** Total duration in ms. */
  durationMs: number
}

function runCapture(cmd: string, args: string[]): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    const stdoutChunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c))
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', code => resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code }))
  })
}

/**
 * Read the recording's start time + duration. Tries (in order):
 *   1. The OBS-default filename pattern `YYYY-MM-DD HH-MM-SS.*` (local time)
 *      — this is the actual recording start the user remembers, and survives
 *      OBS's re-mux / "remux to MP4" feature which rewrites `creation_time`
 *      to the remux moment (sometimes hours after recording finished). The
 *      tell-tale tag is `te_is_reencode` in the format tags.
 *   2. ffprobe `format.tags.creation_time` — for non-OBS recordings (Game
 *      Bar, ShadowPlay, etc.) or files OBS wrote directly without remuxing.
 *   3. Filesystem `birthtime` — Windows file-creation instant. Useful for
 *      MKV (OBS's MKV output doesn't embed creation_time at all).
 *   4. `mtime − duration` — last-ditch, accurate to ~1s.
 *
 * Filename wins #1 over creation_time #2 because in practice the filename
 * is the source of truth for OBS users; the embedded timestamp gets clobbered
 * by remux / re-encode tools. The two converge for un-touched OBS recordings,
 * so the order only matters when they disagree — and when they disagree, the
 * filename is right.
 */
export async function probeVideo(path: string): Promise<VideoInfo> {
  if (!existsSync(path)) throw new Error(`Video not found: ${path}`)
  const { stdout, stderr, code } = await runCapture(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', path,
  ])
  if (code !== 0) throw new Error(`ffprobe failed (${code}): ${stderr || 'no stderr'}`)
  const json = JSON.parse(stdout.toString('utf8')) as {
    format?: { duration?: string; tags?: { creation_time?: string } }
  }
  const fmt = json.format ?? {}
  const durationMs = Math.round(Number(fmt.duration ?? 0) * 1000)
  const stat = statSync(path)

  let creationTimeMs = NaN
  // 1. OBS-default filename pattern: "YYYY-MM-DD HH-MM-SS.*" (local time).
  const m = basename(path).match(/(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:](\d{2})[-:](\d{2})/)
  if (m) {
    const [, Y, M, D, h, min, s] = m
    const t = new Date(Number(Y), Number(M) - 1, Number(D), Number(h), Number(min), Number(s)).getTime()
    if (Number.isFinite(t) && t > 0) creationTimeMs = t
  }
  // 2. ffprobe-reported creation_time (only for files where the filename
  //    didn't match the OBS pattern — e.g. Game Bar, ShadowPlay).
  if (!Number.isFinite(creationTimeMs) || creationTimeMs <= 0) {
    if (fmt.tags?.creation_time) creationTimeMs = Date.parse(fmt.tags.creation_time)
  }
  // 3. Windows file birthtime = recording-start instant for direct-write files.
  if (!Number.isFinite(creationTimeMs) || creationTimeMs <= 0) {
    if (stat.birthtimeMs && stat.birthtimeMs > 0) creationTimeMs = stat.birthtimeMs
  }
  // 4. Last resort: mtime − duration.
  if (!Number.isFinite(creationTimeMs) || creationTimeMs <= 0) {
    creationTimeMs = stat.mtimeMs - durationMs
  }
  return { creationTimeMs, durationMs }
}

/**
 * Extract a single frame at `offsetSec` and return the raw ffmpeg stdout buffer.
 * `outputArgs` chooses the encoding (mjpeg for a JPEG, png for a lossless frame).
 *
 * Fast + frame-accurate hybrid seek: a fast input seek (`-ss` BEFORE `-i`) lands
 * on the keyframe ~PREROLL seconds before the target, then an output seek
 * (`-ss` AFTER `-i`) decodes the small remainder to land EXACTLY on the target.
 * This only decodes ~PREROLL seconds (fast) yet is accurate to the frame — which
 * matters for the per-second frame-nudge scrubber. PREROLL must exceed the OBS
 * keyframe interval (default ~2s) so the fast seek always lands before target.
 */
async function extractFrameBuffer(path: string, offsetSec: number, outputArgs: string[]): Promise<Buffer> {
  const target = Math.max(0, offsetSec)
  const PREROLL = 6
  const pre = Math.max(0, target - PREROLL)
  const post = target - pre
  const args = [
    '-loglevel', 'error',
    '-ss', String(pre),
    '-i', path,
    '-ss', String(post),
    '-frames:v', '1',
    ...outputArgs,
    'pipe:1',
  ]
  const { stdout, stderr, code } = await runCapture(FFMPEG, args)
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`ffmpeg frame extraction failed at ${target.toFixed(2)}s (${code}): ${stderr || 'empty output'}`)
  }
  return stdout
}

/**
 * Extract a single JPEG frame at `offsetSec`, base64-encoded. `-q:v 2` = near-
 * lossless MJPEG so small on-chart text stays as crisp as the source allows.
 */
export async function extractFrameJpegBase64(path: string, offsetSec: number): Promise<string> {
  const buf = await extractFrameBuffer(path, offsetSec, ['-q:v', '2', '-f', 'mjpeg'])
  return buf.toString('base64')
}

export interface FrameTile {
  /** base64 JPEG of this tile. */
  data: string
  row: number
  col: number
  /** Human-readable position, e.g. "top-left", "bottom-right", "center". */
  label: string
}

export interface TiledFrame {
  /** base64 JPEG of the whole frame — overview for layout + screenshot auto-fill. */
  full: string
  tiles: FrameTile[]
  cols: number
  rows: number
  width: number
  height: number
}

function gridName(i: number, n: number, kind: 'row' | 'col'): string {
  if (n === 1) return ''
  if (i === 0) return kind === 'row' ? 'top' : 'left'
  if (i === n - 1) return kind === 'row' ? 'bottom' : 'right'
  if (n === 3) return kind === 'row' ? 'middle' : 'center'
  return `${kind}${i + 1}`
}

/**
 * Extract one frame and slice it into a `cols×rows` grid of high-resolution JPEG
 * tiles, plus a full-frame overview.
 *
 * Why: Anthropic's vision API downsizes any image to ~1.15 MP before the model
 * sees it, so a 3440×1440 ultrawide frame arrives at ~half resolution — the tiny
 * DOM/footprint/order-line numbers become unreadable. Sending magnified crops
 * lets each region reach the model at (near) full recorded resolution.
 *
 * A lossless PNG intermediate avoids double-JPEG compression; tiles overlap by
 * `overlapPx` on every side so a number straddling a seam still appears whole in
 * at least one tile.
 */
export async function extractFrameWithTiles(
  path: string,
  offsetSec: number,
  opts?: { cols?: number; rows?: number; overlapPx?: number; quality?: number },
): Promise<TiledFrame> {
  const cols = Math.max(1, Math.floor(opts?.cols ?? 3))
  const rows = Math.max(1, Math.floor(opts?.rows ?? 2))
  const overlap = Math.max(0, Math.floor(opts?.overlapPx ?? 32))
  const quality = opts?.quality ?? 90

  const png = await extractFrameBuffer(path, offsetSec, ['-c:v', 'png', '-f', 'image2pipe'])
  const meta = await sharp(png).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new Error('could not read frame dimensions for tiling')

  const full = (await sharp(png).jpeg({ quality }).toBuffer()).toString('base64')

  const tiles: FrameTile[] = []
  const baseW = Math.floor(W / cols)
  const baseH = Math.floor(H / rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * baseW
      const y0 = r * baseH
      const w0 = c === cols - 1 ? W - x0 : baseW
      const h0 = r === rows - 1 ? H - y0 : baseH
      const left = Math.max(0, x0 - overlap)
      const top = Math.max(0, y0 - overlap)
      const right = Math.min(W, x0 + w0 + overlap)
      const bottom = Math.min(H, y0 + h0 + overlap)
      const data = (await sharp(png)
        .extract({ left, top, width: right - left, height: bottom - top })
        .jpeg({ quality })
        .toBuffer()).toString('base64')
      const label = [gridName(r, rows, 'row'), gridName(c, cols, 'col')].filter(Boolean).join('-') || 'full'
      tiles.push({ data, row: r, col: c, label })
    }
  }
  return { full, tiles, cols, rows, width: W, height: H }
}
