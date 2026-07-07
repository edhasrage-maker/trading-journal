/**
 * Tiny IndexedDB store for File System Access API handles, so the file picker
 * can reopen at the folder you last imported from. A FileSystemFileHandle is
 * structured-cloneable, so we persist the last-picked one and pass it back as
 * `showOpenFilePicker({ startIn })` — the picker opens in that file's directory.
 *
 * All functions no-op (return null / resolve) when IndexedDB is unavailable
 * (SSR, private-mode quirks), so callers can use them unconditionally.
 */

const DB_NAME = 'tapescore-file-handles'
const STORE = 'handles'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

/** Retrieve a previously-saved handle by key, or null if none / unsupported. */
export async function getHandle(key: string): Promise<FileSystemHandle | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => { db.close(); resolve((req.result as FileSystemHandle) ?? null) }
      req.onerror = () => { db.close(); resolve(null) }
    } catch {
      db.close()
      resolve(null)
    }
  })
}

/** Persist a handle under key. Silently ignores failures (best-effort memory). */
export async function setHandle(key: string, handle: FileSystemHandle): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(handle, key)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
    } catch {
      db.close()
      resolve()
    }
  })
}
