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
  // maxWidth well above a 1440p/ultrawide capture so SAVED frames keep detail
  // (the grabber's 1280 default was the source of the earlier blur).
  const g = new VideoFrameGrabber(file, { maxWidth: 2560, quality: 0.92 })
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
