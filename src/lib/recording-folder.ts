'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { parseObsFilenameStartMs } from './browser-frames'
import { isRecordingName, type TimedClip } from './recording-match'

/**
 * A LOCKED recordings folder — one per surface, remembered on this device.
 *
 * WHY THIS EXISTS: the app used to remember one recording FILE, in one global
 * slot. A file is yesterday's news by tomorrow, so the clip was re-picked every
 * day; and because the Trade tab's "Adjust frame" and the Review recap shared
 * the slot, picking on one silently changed what the other offered.
 *
 * So: remember the FOLDER, and find each day's recording inside it by the time
 * in its filename (`recording-match.ts`). And keep a separate slot per surface
 * — they may point at the same folder, but neither can overwrite the other.
 *
 * What the browser allows: a directory handle survives in IndexedDB, but the
 * permission to read it is the browser's to hold, not ours. On return it is
 * either still granted (Chrome's "Allow on every visit") or one click away —
 * never a trip through the file dialog. Chromium only; everything here no-ops
 * where `showDirectoryPicker` is missing, and those browsers keep the plain
 * file picker.
 *
 * Nothing in this module reads video. It hands back handles; decoding stays in
 * the browser with the caller, so the recording still never leaves the device.
 */

export type RecordingSurface = 'trade' | 'recap'

// ── FS Access API types (not in the project's TS lib) ───────────────────────
type PermState = 'granted' | 'denied' | 'prompt'
interface FsFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
}
interface FsDirHandle {
  kind: 'directory'
  name: string
  values(): AsyncIterable<FsFileHandle | FsDirHandle>
  queryPermission?(d?: { mode?: 'read' | 'readwrite' }): Promise<PermState>
  requestPermission?(d?: { mode?: 'read' | 'readwrite' }): Promise<PermState>
}
interface FsWindow {
  showDirectoryPicker?(opts?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: unknown }): Promise<FsDirHandle>
  showOpenFilePicker?(opts?: {
    multiple?: boolean
    startIn?: unknown
    types?: { description?: string; accept: Record<string, string[]> }[]
  }): Promise<FsFileHandle[]>
}

/** Can this browser lock a folder at all? */
export const supportsFolderLock = (): boolean =>
  typeof window !== 'undefined' && typeof (window as FsWindow).showDirectoryPicker === 'function'

/** Can it open the native file picker (vs. a plain `<input type="file">`)? */
export const supportsFsAccess = (): boolean =>
  typeof window !== 'undefined' && typeof (window as FsWindow).showOpenFilePicker === 'function'

const dismissed = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError'

// ── State ───────────────────────────────────────────────────────────────────
export interface FolderState {
  /** False until the saved folder has been looked up (IndexedDB is async). */
  checked: boolean
  /** Whether this browser can lock a folder. Known once `checked`. */
  supported: boolean
  /** The locked folder's name; null when none is locked on this device. */
  name: string | null
  /** granted — readable now. prompt — locked, but the browser wants one click
   *  to re-allow it. denied — that click was refused. missing — allowed, but
   *  the folder can't be read (moved, renamed, drive unplugged). */
  access: 'granted' | 'prompt' | 'denied' | 'missing' | null
  /** Bumps whenever the folder is (re)chosen or re-allowed — a cue to look again. */
  rev: number
}

const UNCHECKED: FolderState = { checked: false, supported: false, name: null, access: null, rev: 0 }

interface Slot {
  state: FolderState
  handle: FsDirHandle | null
  /** Where the folder picker opens when this surface has no folder yet. */
  startHint: unknown
  listeners: Set<() => void>
  checking: Promise<void> | null
  subscribe: (l: () => void) => () => void
  get: () => FolderState
}
function newSlot(): Slot {
  const slot: Slot = {
    state: UNCHECKED, handle: null, startHint: undefined, listeners: new Set(), checking: null,
    subscribe: l => { slot.listeners.add(l); return () => slot.listeners.delete(l) },
    get: () => slot.state,
  }
  return slot
}
const slots: Record<RecordingSurface, Slot> = { trade: newSlot(), recap: newSlot() }

function set(slot: Slot, patch: Partial<FolderState>) {
  slot.state = { ...slot.state, ...patch }
  for (const l of slot.listeners) l()
}

// ── IndexedDB: directory handles are structured-cloneable ───────────────────
const DB_NAME = 'tapescore-recording'
const STORE = 'handles'
const folderKey = (s: RecordingSurface) => `folder:${s}`
/** The single remembered FILE handle from before folders. Never loaded any
 *  more — it survives only as a hint for where the folder picker should open,
 *  and is dropped once a folder is locked. */
const LEGACY_FILE_KEY = 'current'

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
async function idbGet(key: string): Promise<unknown> {
  const db = await openDb(); if (!db) return null
  const value = await new Promise<unknown>(resolve => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    r.onsuccess = () => resolve(r.result ?? null)
    r.onerror = () => resolve(null)
  })
  db.close()
  return value
}
async function idbWrite(run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDb(); if (!db) return
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readwrite')
    run(tx.objectStore(STORE))
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
  db.close()
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Once per page per surface: surface the locked folder and where its
 *  permission stands. Reads nothing from the folder itself. */
function checkSaved(surface: RecordingSurface): Promise<void> {
  const slot = slots[surface]
  slot.checking ??= (async () => {
    if (!supportsFolderLock()) { set(slot, { checked: true, supported: false }); return }
    const other: RecordingSurface = surface === 'trade' ? 'recap' : 'trade'
    const [saved, otherSaved, legacy] = await Promise.all([
      idbGet(folderKey(surface)), idbGet(folderKey(other)), idbGet(LEGACY_FILE_KEY),
    ])
    // No folder here yet? Open the picker where the other surface's folder is,
    // or where the last single clip came from — never a cold start.
    slot.startHint = otherSaved ?? legacy ?? 'videos'
    const handle = saved as FsDirHandle | null
    if (!handle) { set(slot, { checked: true, supported: true }); return }
    slot.handle = handle
    const perm = (await handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as const)) ?? 'prompt'
    set(slot, { checked: true, supported: true, name: handle.name, access: perm })
  })()
  return slot.checking
}

/** Lock a folder for this surface (or re-point it). Needs a click. Resolves
 *  false when the picker was dismissed. */
export async function chooseFolder(surface: RecordingSurface): Promise<boolean> {
  const slot = slots[surface]
  const w = window as FsWindow
  if (!w.showDirectoryPicker) return false
  // A distinct id per surface, so the browser also keeps their dialogs apart.
  const base = { id: `tapescore-rec-${surface}`, mode: 'read' as const }
  let handle: FsDirHandle
  try {
    handle = await w.showDirectoryPicker({ ...base, startIn: slot.handle ?? slot.startHint })
  } catch (e) {
    if (dismissed(e)) return false
    // A stale hint (its file or folder is gone) rejects before any dialog
    // shows — which would read as a dead button. Ask again without it.
    try { handle = await w.showDirectoryPicker(base) } catch { return false }
  }
  slot.handle = handle
  const other = slots[surface === 'trade' ? 'recap' : 'trade']
  if (!other.handle) other.startHint = handle
  await idbWrite(store => { store.put(handle, folderKey(surface)); store.delete(LEGACY_FILE_KEY) }).catch(() => {})
  set(slot, { name: handle.name, access: 'granted', rev: slot.state.rev + 1 })
  return true
}

/** Re-allow the locked folder after a return visit. Needs a click. */
export async function allowFolder(surface: RecordingSurface): Promise<boolean> {
  const slot = slots[surface]
  if (!slot.handle) return false
  const perm = (await slot.handle.requestPermission?.({ mode: 'read' }).catch(() => 'denied' as const)) ?? 'denied'
  set(slot, { access: perm, rev: slot.state.rev + 1 })
  return perm === 'granted'
}

// ── Reading the folder ──────────────────────────────────────────────────────
export interface FolderClip extends TimedClip {
  handle: FsFileHandle
}
export interface FolderListing {
  /** The folder's name, and the `rev` it was read under. */
  folder: string
  rev: number
  /** Recordings whose filename carries a start time — the only ones that can be matched. */
  clips: FolderClip[]
  /** Video files with no date and time in the name. Counted so we can say so. */
  untimed: number
}

/** The recordings sitting in the locked folder right now (top level only — OBS
 *  doesn't nest). Read fresh on every call: today's file appears mid-session.
 *  Null when the folder can't be read; the slot's `access` then says why. */
export async function listFolderClips(surface: RecordingSurface): Promise<FolderListing | null> {
  const slot = slots[surface]
  const handle = slot.handle
  if (!handle || slot.state.access !== 'granted') return null
  const clips: FolderClip[] = []
  let untimed = 0
  try {
    for await (const entry of handle.values()) {
      if (entry.kind !== 'file' || !isRecordingName(entry.name)) continue
      const startMs = parseObsFilenameStartMs(entry.name)
      if (startMs == null) untimed++
      else clips.push({ name: entry.name, startMs, handle: entry })
    }
  } catch {
    // Either the grant lapsed under us, or the folder itself is gone.
    const perm = (await handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as const)) ?? 'prompt'
    set(slot, { access: perm === 'granted' ? 'missing' : perm })
    return null
  }
  return { folder: handle.name, rev: slot.state.rev, clips, untimed }
}

/** The surface's current folder revision — see `FolderState.rev`. */
export const folderRevision = (surface: RecordingSurface): number => slots[surface].state.rev

const VIDEO_TYPES = [{
  description: 'Screen recording',
  // Concrete MIME keys — showOpenFilePicker rejects a `video/*` wildcard.
  accept: {
    'video/mp4': ['.mp4', '.m4v'],
    'video/webm': ['.webm'],
    'video/x-matroska': ['.mkv'],
    'video/quicktime': ['.mov'],
  },
}]

/** One recording, picked by hand — the explicit way out when the folder has
 *  nothing for a day. Opens in the locked folder when there is one. Deliberately
 *  remembers NOTHING: a hand-picked clip is for now, and must never come back
 *  on its own for some other day. Null when dismissed or unsupported (callers
 *  fall back to an `<input type="file">`). */
export async function pickRecordingFile(surface: RecordingSurface): Promise<File | null> {
  const slot = slots[surface]
  const w = window as FsWindow
  if (!w.showOpenFilePicker) return null
  let handle: FsFileHandle | undefined
  try {
    ;[handle] = await w.showOpenFilePicker({ types: VIDEO_TYPES, startIn: slot.handle ?? undefined })
  } catch (e) {
    if (dismissed(e)) return null
    try { ;[handle] = await w.showOpenFilePicker({ types: VIDEO_TYPES }) } catch { return null }
  }
  if (!handle) return null
  try { return await handle.getFile() } catch { return null }
}

// ── React binding ───────────────────────────────────────────────────────────
export function useRecordingFolder(surface: RecordingSurface): FolderState {
  const slot = slots[surface]
  const snap = useSyncExternalStore(slot.subscribe, slot.get, () => UNCHECKED)
  // Kick off the one-time saved-folder lookup after mount (client-only).
  useEffect(() => { void checkSaved(surface) }, [surface])
  return snap
}
