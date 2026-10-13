'use client'

import { useSyncExternalStore } from 'react'
import { VideoFrameGrabber, parseObsFilenameStartMs } from './browser-frames'
import { clipCovers, clipForInstant } from './recording-match'
import { folderRevision, listFolderClips, pickRecordingFile } from './recording-folder'

/**
 * The screen recording the Trade tab's "Adjust frame" is reading — one clip,
 * shared by every frame-nudge on the page.
 *
 * WHY THIS EXISTS: BrowserFrameNudge decodes the clip in the browser (the file
 * never leaves the machine). Without a shared store every trade would open and
 * decode its own copy, so the File + its VideoFrameGrabber live at module
 * scope: the first trade loads the clip and the rest of the day reuses it.
 *
 * WHERE THE CLIP COMES FROM: the Trade tab's locked recordings folder
 * (`recording-folder.ts`, surface 'trade'). `loadFolderClipFor` finds the
 * recording that was running at a trade's moment and loads it — and when the
 * folder has none, it says so and loads nothing. A clip picked by hand is the
 * explicit way out; it lives only until the page reloads.
 *
 * This store belongs to the Trade tab alone. The Review recap keeps its own
 * folder and its own decode pipeline, and neither can change the other's clip.
 */

// ── State ───────────────────────────────────────────────────────────────────
export interface RecordingState {
  file: File | null
  grabber: VideoFrameGrabber | null
  name: string | null
  duration: number
  /** Recording start (ms epoch): from the OBS filename, else file date − duration. */
  anchorMs: number | null
  anchorSource: 'filename' | 'filedate' | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** How this clip got here: matched in the locked folder, or picked by hand. */
  origin: 'folder' | 'manual' | null
  /** The folder it was matched in (origin 'folder'). */
  folderName: string | null
}

const INITIAL: RecordingState = {
  file: null, grabber: null, name: null, duration: 0,
  anchorMs: null, anchorSource: null, status: 'idle', error: null, origin: null, folderName: null,
}

let state: RecordingState = INITIAL
const listeners = new Set<() => void>()
function setState(patch: Partial<RecordingState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

// ── Ingest: build the grabber + compute the recording anchor ────────────────
async function ingest(file: File, origin: 'folder' | 'manual', folderName: string | null = null): Promise<void> {
  state.grabber?.dispose()
  setState({ status: 'loading', file, name: file.name, grabber: null, error: null, origin, folderName })
  // Effectively native: 3840 clears a 3440-wide ultrawide capture, and grab()
  // only ever downscales, so this never upscales a smaller source — it just
  // stops throwing away resolution. Adjust-frame saves one frame at a time, so
  // full-res parity with pasted screenshots costs nothing here. quality 0.95 to
  // keep Sierra's thin text/lines crisp under JPEG.
  const g = new VideoFrameGrabber(file, { maxWidth: 3840, quality: 0.95 })
  try {
    await g.ready
  } catch {
    g.dispose()
    setState({ status: 'error', grabber: null, error: 'Could not decode that file. OBS .mkv usually needs remuxing to .mp4 — a browser can only play a codec it ships with.' })
    return
  }
  const fromName = parseObsFilenameStartMs(file.name)
  setState({
    status: 'ready',
    grabber: g,
    duration: g.duration,
    anchorMs: fromName ?? file.lastModified - g.duration * 1000,
    anchorSource: fromName ? 'filename' : 'filedate',
    error: null,
  })
}

// ── Public actions ──────────────────────────────────────────────────────────

/** What looking in the locked folder for a moment came back with. */
export type FolderLookup =
  /** The clip now loaded runs through that moment. */
  | { kind: 'found' }
  /** Nothing in the folder does. `nearest` is the recording that started
   *  closest before it, when there was one — it had already ended. */
  | { kind: 'none'; nearest: string | null; untimed: number }
  /** The right recording is there, but this browser can't decode it. */
  | { kind: 'undecodable'; name: string }
  /** The folder couldn't be read; its `access` state says why. */
  | { kind: 'unreadable' }

/** The folder revision the loaded folder clip was matched under. */
let clipFolderRev = -1

async function lookup(ms: number): Promise<FolderLookup> {
  // A clip matched before the folder was re-pointed is the OLD folder's answer.
  // Drop it, so what shows is always what the folder locked now holds.
  if (state.origin === 'folder' && clipFolderRev !== folderRevision('trade')) clearRecording()
  // Already holding a clip that runs through this moment — the usual case for
  // the second trade of the day. Nothing to open.
  if (state.status === 'ready' && state.anchorMs != null && clipCovers(state.anchorMs, state.duration, ms)) {
    return { kind: 'found' }
  }
  const listing = await listFolderClips('trade')
  if (!listing) return { kind: 'unreadable' }
  const clip = clipForInstant(listing.clips, ms)
  if (!clip) return { kind: 'none', nearest: null, untimed: listing.untimed }
  let file: File
  try { file = await clip.handle.getFile() } catch { return { kind: 'unreadable' } }
  await ingest(file, 'folder', listing.folder)
  clipFolderRev = listing.rev
  if (state.status !== 'ready') {
    clearRecording()
    return { kind: 'undecodable', name: clip.name }
  }
  if (state.anchorMs != null && clipCovers(state.anchorMs, state.duration, ms)) return { kind: 'found' }
  // The filename only says when it started. It had stopped by this moment, so
  // it is NOT this trade's recording — drop it rather than show the wrong tape.
  clearRecording()
  return { kind: 'none', nearest: clip.name, untimed: listing.untimed }
}

let lookups: Promise<unknown> = Promise.resolve()
/** Load the recording in the Trade tab's locked folder that was running at
 *  `ms`. Calls run one at a time: there is one clip, and two trades asking at
 *  once must not load over each other mid-decode. */
export function loadFolderClipFor(ms: number): Promise<FolderLookup> {
  const run = lookups.then(() => lookup(ms))
  lookups = run.catch(() => {})
  return run
}

/** Pick one recording by hand through the native picker (Chromium). Resolves
 *  false when dismissed or unsupported — those browsers call `ingestFile` from
 *  an <input>. Nothing is remembered. */
export async function pickRecordingManually(): Promise<boolean> {
  const file = await pickRecordingFile('trade')
  if (!file) return false
  await ingest(file, 'manual')
  return true
}

/** Load the clip from a plain <input> File (the non-Chromium path). */
export async function ingestFile(file: File): Promise<void> {
  await ingest(file, 'manual')
}

export function clearRecording(): void {
  state.grabber?.dispose()
  setState({ ...INITIAL })
}

// ── React binding ───────────────────────────────────────────────────────────
export function useRecording(): RecordingState {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => listeners.delete(l) },
    () => state,
    () => INITIAL,
  )
}
