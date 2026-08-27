'use client'

import { useSyncExternalStore, useEffect } from 'react'
import { VideoFrameGrabber, parseObsFilenameStartMs } from './browser-frames'

/**
 * One picked screen recording, shared across every frame-nudge on the page, and
 * remembered across visits where the browser allows it.
 *
 * WHY THIS EXISTS: BrowserFrameNudge decodes the clip in the browser (the file
 * never leaves the machine). Without a shared store, every trade owns its own
 * file picker, so adjusting five frames = five dialogs, and every page reload
 * starts from zero. This store solves both:
 *
 *   1. Once per page — the File + its VideoFrameGrabber live at module scope, so
 *      the first pick serves every trade you touch until a hard reload.
 *   2. Once per browser — on Chromium we keep the File System Access *handle* in
 *      IndexedDB. A handle is not the file (browsers can never silently read
 *      local files — a hard, correct security line), but re-granting it is one
 *      click ("Re-open recording.mp4") instead of navigating the file dialog.
 *
 * Non-Chromium browsers (Firefox/Safari) fall back to a normal <input> picker;
 * #1 still works, #2 is simply absent.
 */

// ── FS Access API types (not in the project's TS lib) ───────────────────────
type PermState = 'granted' | 'denied' | 'prompt'
interface FsFileHandle {
  name: string
  getFile(): Promise<File>
  queryPermission?(d?: { mode?: 'read' | 'readwrite' }): Promise<PermState>
  requestPermission?(d?: { mode?: 'read' | 'readwrite' }): Promise<PermState>
}
interface FsPickerWindow {
  showOpenFilePicker?(opts?: {
    multiple?: boolean
    types?: { description?: string; accept: Record<string, string[]> }[]
  }): Promise<FsFileHandle[]>
}

export const supportsFsAccess = (): boolean =>
  typeof window !== 'undefined' && typeof (window as FsPickerWindow).showOpenFilePicker === 'function'

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
  /** A persisted handle exists but isn't loaded yet — offer a one-click re-open. */
  savedHandleName: string | null
}

const INITIAL: RecordingState = {
  file: null, grabber: null, name: null, duration: 0,
  anchorMs: null, anchorSource: null, status: 'idle', error: null, savedHandleName: null,
}

let state: RecordingState = INITIAL
const listeners = new Set<() => void>()
function setState(patch: Partial<RecordingState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

// ── IndexedDB: persist the FS Access handle (structured-cloneable) ──────────
const DB_NAME = 'tapescore-recording'
const STORE = 'handles'
const KEY = 'current'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(DB_NAME, 1) } catch { resolve(null); return }
    req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE) } catch { /* exists */ } }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}
async function saveHandle(handle: FsFileHandle): Promise<void> {
  const db = await openDb(); if (!db) return
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(handle, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
  db.close()
}
async function loadHandle(): Promise<FsFileHandle | null> {
  const db = await openDb(); if (!db) return null
  const handle = await new Promise<FsFileHandle | null>(resolve => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(KEY)
    r.onsuccess = () => resolve((r.result as FsFileHandle) ?? null)
    r.onerror = () => resolve(null)
  })
  db.close()
  return handle
}

// ── Ingest: build the grabber + compute the recording anchor ────────────────
async function ingest(file: File): Promise<void> {
  state.grabber?.dispose()
  setState({ status: 'loading', file, name: file.name, grabber: null, error: null })
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

/** Pick via the FS Access picker (Chromium) — persists the handle for next time.
 *  No-op on browsers without the API; those call `ingestFile` from an <input>. */
export async function pickRecordingViaHandle(): Promise<void> {
  const w = window as FsPickerWindow
  if (!w.showOpenFilePicker) return
  let handle: FsFileHandle | undefined
  try {
    // Concrete MIME keys — showOpenFilePicker rejects a `video/*` wildcard, and
    // our catch would swallow that as a cancel (a dead-feeling button).
    ;[handle] = await w.showOpenFilePicker({
      types: [{
        description: 'Screen recording',
        accept: {
          'video/mp4': ['.mp4', '.m4v'],
          'video/webm': ['.webm'],
          'video/x-matroska': ['.mkv'],
          'video/quicktime': ['.mov'],
        },
      }],
    })
  } catch {
    return // user dismissed the picker
  }
  if (!handle) return
  await saveHandle(handle).catch(() => {})
  setState({ savedHandleName: handle.name })
  await ingest(await handle.getFile())
}

/** Load the clip from a plain <input> File (the non-Chromium fallback). */
export async function ingestFile(file: File): Promise<void> {
  await ingest(file)
}

/** Pick a recording and REMEMBER it, without building a grabber here.
 *
 *  For callers that run their own decode pipeline (the Review recap does — it
 *  keeps a per-day anchor the store doesn't model) but should still leave the
 *  handle behind for everything else. Without this, picking a recording on
 *  Review taught the rest of the app nothing, and the Trade tab asked for the
 *  same file again as though it had never been chosen.
 *
 *  Returns the File so the caller can proceed as before, or null if the picker
 *  was dismissed or the browser has no FS Access API. */
export async function pickAndRememberFile(): Promise<File | null> {
  const w = window as FsPickerWindow
  if (!w.showOpenFilePicker) return null
  let handle: FsFileHandle | undefined
  try {
    ;[handle] = await w.showOpenFilePicker({
      types: [{
        description: 'Screen recording',
        accept: {
          'video/mp4': ['.mp4', '.m4v'],
          'video/webm': ['.webm'],
          'video/x-matroska': ['.mkv'],
          'video/quicktime': ['.mov'],
        },
      }],
    })
  } catch {
    return null // dismissed
  }
  if (!handle) return null
  await saveHandle(handle).catch(() => {})
  setState({ savedHandleName: handle.name })
  return handle.getFile()
}

/** The remembered clip's filename, if one was ever picked on this device.
 *  Lets a surface offer "re-open <name>" instead of a bare file picker. */
export async function savedRecordingName(): Promise<string | null> {
  const handle = await loadHandle()
  return handle?.name ?? null
}

/** Re-grant and return the saved clip as a File, for a caller with its own
 *  pipeline. Needs a user gesture. Null when there's nothing saved or the
 *  grant was declined. */
export async function reopenSavedFile(): Promise<File | null> {
  const handle = await loadHandle()
  if (!handle) return null
  const perm = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied'
  if (perm !== 'granted') return null
  setState({ savedHandleName: handle.name })
  try { return await handle.getFile() } catch { return null }
}

/** Re-grant + load a previously-saved handle. Needs a user gesture (a click). */
export async function reopenSavedRecording(): Promise<void> {
  const handle = await loadHandle()
  if (!handle) return
  const perm = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied'
  if (perm !== 'granted') {
    setState({ status: 'error', error: 'Permission to read the file was declined.' })
    return
  }
  await ingest(await handle.getFile())
}

let restoreTried = false
/** Once per page: surface a saved handle, auto-loading it if permission already
 *  persists (rare on a plain site — usually the user re-grants with one click). */
async function restoreSavedHandle(): Promise<void> {
  if (restoreTried || !supportsFsAccess()) return
  restoreTried = true
  const handle = await loadHandle()
  if (!handle) return
  setState({ savedHandleName: handle.name })
  const perm = (await handle.queryPermission?.({ mode: 'read' })) ?? 'prompt'
  if (perm === 'granted') {
    try { await ingest(await handle.getFile()) } catch { /* leave the re-open affordance */ }
  }
}

export function clearRecording(): void {
  state.grabber?.dispose()
  setState({ ...INITIAL })
}

// ── React binding ───────────────────────────────────────────────────────────
export function useRecording(): RecordingState {
  const snap = useSyncExternalStore(
    l => { listeners.add(l); return () => listeners.delete(l) },
    () => state,
    () => INITIAL,
  )
  // Kick off the one-time saved-handle restore after mount (client-only).
  useEffect(() => { void restoreSavedHandle() }, [])
  return snap
}
