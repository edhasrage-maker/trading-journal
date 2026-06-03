import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { basename } from 'path'

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
 * Extract a single JPEG frame at `offsetSec` and return it base64-encoded.
 * Uses `-ss` BEFORE `-i` for fast (keyframe-aligned) seek — accurate to ~1s,
 * which is plenty for screen-recording commentary.
 */
export async function extractFrameJpegBase64(path: string, offsetSec: number): Promise<string> {
  const args = [
    '-loglevel', 'error',
    '-ss', String(Math.max(0, offsetSec)),
    '-i', path,
    '-frames:v', '1',
    '-f', 'mjpeg',
    'pipe:1',
  ]
  const { stdout, stderr, code } = await runCapture(FFMPEG, args)
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`ffmpeg frame extraction failed at ${offsetSec.toFixed(2)}s (${code}): ${stderr || 'empty output'}`)
  }
  return stdout.toString('base64')
}
