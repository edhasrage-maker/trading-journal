import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'

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
 * Read the recording's start time + duration. OBS embeds creation_time in the
 * MP4/MKV container; if it's missing (some recorders don't set it), we fall
 * back to filesystem mtime minus duration, which is accurate to ~1s.
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
  let creationTimeMs = NaN
  if (fmt.tags?.creation_time) creationTimeMs = Date.parse(fmt.tags.creation_time)
  if (!Number.isFinite(creationTimeMs) || creationTimeMs <= 0) {
    // Fallback: file mtime - duration. ~1s accuracy, enough for "what's on screen".
    creationTimeMs = statSync(path).mtimeMs - durationMs
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
