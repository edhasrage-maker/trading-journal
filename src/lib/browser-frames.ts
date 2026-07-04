/**
 * Browser-native video frame extraction — the cloud counterpart to the local
 * ffmpeg path in `src/lib/video-frames.ts`.
 *
 * On a hosted deployment (Vercel) there is no filesystem and no ffmpeg, so OBS
 * frame commentary can't run server-side. Instead the USER's browser decodes
 * their own recording: an `<video>` element (fed an object URL) seeks to a
 * target time and a `<canvas>` grabs that frame as a JPEG data URL. The video
 * file itself NEVER leaves the machine — only the small extracted JPEGs would
 * (later, in Phase 2, when AI commentary is wired up).
 *
 * Codec note: browsers decode MP4 / H.264 natively. MKV (OBS's default) won't
 * load — `ready` rejects with a clear message. A `ffmpeg.wasm` fallback is a
 * Phase-3 polish item, not built here.
 *
 * This module touches `document`, so it must only be used in the browser. It
 * carries no module-level DOM access (all of it is inside the class), so it is
 * safe to import from a Client Component; just don't instantiate during SSR.
 */

/** Parse the OBS-default filename pattern `YYYY-MM-DD HH-MM-SS` into an epoch-ms
 *  instant, interpreted in the BROWSER's local timezone (which, for a trader
 *  recording their own screen, is the same wall-clock the market clock shows).
 *  Mirrors the server `probeVideo` filename heuristic. Returns null if the name
 *  doesn't carry a recognisable timestamp. */
export function parseObsFilenameStartMs(name: string): number | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:](\d{2})[-:](\d{2})/)
  if (!m) return null
  const [, Y, Mo, D, h, mi, s] = m
  const t = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(h), Number(mi), Number(s)).getTime()
  return Number.isFinite(t) && t > 0 ? t : null
}

export interface GrabberOptions {
  /** Downscale grabbed frames so their width never exceeds this (keeps JPEGs
   *  small for eventual upload). Height scales proportionally. Default 1280. */
  maxWidth?: number
  /** JPEG quality 0–1. Default 0.82. */
  quality?: number
}

/**
 * Wraps a single off-screen `<video>` + `<canvas>` pair for one recording.
 * `grab(atSec)` seeks and returns a JPEG data URL; calls are serialised
 * internally (a `<video>` can only seek one place at a time), so callers can
 * fire many `grab()`s and they resolve in order without clobbering each other.
 */
export class VideoFrameGrabber {
  private readonly video: HTMLVideoElement
  private readonly canvas: HTMLCanvasElement
  private readonly objectUrl: string
  private readonly maxWidth: number
  private readonly quality: number
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  /** Resolves once metadata (duration + dimensions) is available; rejects on a
   *  decode/codec error. Await before reading `duration`/`width`/`height`. */
  readonly ready: Promise<void>
  duration = 0
  width = 0
  height = 0

  constructor(file: File, opts: GrabberOptions = {}) {
    this.maxWidth = opts.maxWidth ?? 1280
    this.quality = opts.quality ?? 0.82
    this.objectUrl = URL.createObjectURL(file)

    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.playsInline = true
    v.src = this.objectUrl
    this.video = v
    this.canvas = document.createElement('canvas')

    this.ready = new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        this.duration = Number.isFinite(v.duration) ? v.duration : 0
        this.width = v.videoWidth
        this.height = v.videoHeight
        cleanup()
        if (!this.width || !this.height) {
          reject(new Error('Recording has no video track this browser can decode. Export as MP4 / H.264.'))
        } else {
          resolve()
        }
      }
      const onErr = () => {
        cleanup()
        reject(new Error('Could not load this recording. Browsers decode MP4 / H.264 — MKV and some codecs are unsupported.'))
      }
      const cleanup = () => {
        v.removeEventListener('loadedmetadata', onMeta)
        v.removeEventListener('error', onErr)
      }
      v.addEventListener('loadedmetadata', onMeta)
      v.addEventListener('error', onErr)
    })
  }

  /** Seek to `atSec` (clamped into range) and return the frame as a JPEG data
   *  URL. Serialised against other `grab()` calls on this instance. */
  grab(atSec: number): Promise<string> {
    const run = async (): Promise<string> => {
      if (this.disposed) throw new Error('grabber disposed')
      await this.ready
      const t = Math.min(Math.max(0, atSec), Math.max(0, this.duration - 0.05))
      await this.seek(t)
      const scale = this.width > this.maxWidth ? this.maxWidth / this.width : 1
      const w = Math.max(1, Math.round(this.width * scale))
      const h = Math.max(1, Math.round(this.height * scale))
      this.canvas.width = w
      this.canvas.height = h
      const ctx = this.canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d context unavailable')
      ctx.drawImage(this.video, 0, 0, w, h)
      return this.canvas.toDataURL('image/jpeg', this.quality)
    }
    // Chain on the queue so seeks never overlap. Swallow prior errors so one
    // failed grab doesn't poison the whole queue.
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  private seek(t: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const v = this.video
      if (Math.abs(v.currentTime - t) < 0.02 && v.readyState >= 2) {
        resolve()
        return
      }
      const onSeeked = () => { cleanup(); resolve() }
      const onErr = () => { cleanup(); reject(new Error('seek failed')) }
      const cleanup = () => {
        clearTimeout(timer)
        v.removeEventListener('seeked', onSeeked)
        v.removeEventListener('error', onErr)
      }
      // Guard against a browser that never fires `seeked` (rare, but a hung
      // promise would stall the whole queue). 8s is generous for a local seek.
      const timer = setTimeout(() => { cleanup(); reject(new Error('seek timed out')) }, 8000)
      v.addEventListener('seeked', onSeeked)
      v.addEventListener('error', onErr)
      v.currentTime = t
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try { URL.revokeObjectURL(this.objectUrl) } catch { /* ignore */ }
    try {
      this.video.removeAttribute('src')
      this.video.load()
    } catch { /* ignore */ }
  }
}
