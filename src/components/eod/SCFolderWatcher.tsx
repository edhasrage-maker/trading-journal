'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, FolderCheck, Loader2, X } from 'lucide-react'

/**
 * Auto-import Sierra Chart trade activity logs from a watched folder.
 *
 * Uses the browser File System Access API (Chrome/Edge/Opera). The user clicks
 * "Watch folder", grants access to C:\SierraChart\TradeActivityLogs, and from
 * then on (while any page in the app is open) the watcher polls every 60s for
 * new or modified `TradeActivityLog_YYYY-MM-DD*.txt` files and POSTs them to
 * `/api/import-sc-log` with the date extracted from the filename. The existing
 * logged-in session cookie authenticates the request — no extra token needed.
 *
 * Per-file mtime state is persisted in localStorage so we don't re-upload
 * unchanged files. The dedup index on `sierra_trade_id` makes re-uploads
 * idempotent anyway, but skipping unchanged files avoids unnecessary API churn.
 *
 * Folder permission resets per browser session — the user re-clicks once per
 * session. We don't persist the folder handle in IndexedDB to keep this simple.
 */

const FILE_RE = /^TradeActivityLog_(\d{4}-\d{2}-\d{2}).*\.txt$/i
const POLL_MS = 60_000
const STATE_KEY = 'sc-watcher-state-v1'

interface FileState {
  mtime: number
  lastImport: string
  inserted: number
}

interface ImportResponse {
  inserted: number
  skippedDuplicates: number
  skippedFiltered: number
  parseErrors: string[]
}

interface Props {
  onActivity: (msg: string, type: 'success' | 'error') => void
  onImported: () => void
}

// Minimal FSA API typing — the global lib types vary across TS versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FsHandle = any

export default function SCFolderWatcher({ onActivity, onImported }: Props) {
  const [handle, setHandle] = useState<FsHandle | null>(null)
  const [polling, setPolling] = useState(false)
  const [lastCheck, setLastCheck] = useState<Date | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onActivityRef = useRef(onActivity)
  const onImportedRef = useRef(onImported)

  useEffect(() => { onActivityRef.current = onActivity }, [onActivity])
  useEffect(() => { onImportedRef.current = onImported }, [onImported])

  const loadState = (): Record<string, FileState> => {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') as Record<string, FileState>
    } catch {
      return {}
    }
  }
  const saveState = (s: Record<string, FileState>) => {
    localStorage.setItem(STATE_KEY, JSON.stringify(s))
  }

  const tick = useCallback(async (h: FsHandle) => {
    setPolling(true)
    setLastCheck(new Date())
    const state = loadState()
    let totalInserted = 0
    let filesUploaded = 0

    try {
      for await (const entry of h.values()) {
        if (entry.kind !== 'file') continue
        const m = FILE_RE.exec(entry.name)
        if (!m) continue
        const date = m[1]
        const file: File = await entry.getFile()
        const lastMtime = state[entry.name]?.mtime ?? 0
        if (file.lastModified <= lastMtime) continue

        const fd = new FormData()
        fd.append('file', file)
        fd.append('date', date)
        const res = await fetch('/api/import-sc-log', { method: 'POST', body: fd })
        if (!res.ok) {
          let detail = ''
          try {
            const data = await res.json() as { error?: string }
            detail = data.error ?? `${res.status}`
          } catch {
            detail = `${res.status} ${res.statusText}`
          }
          onActivityRef.current(`Watcher: ${entry.name} failed — ${detail}`, 'error')
          continue
        }
        const result = (await res.json()) as ImportResponse
        state[entry.name] = {
          mtime: file.lastModified,
          lastImport: new Date().toISOString(),
          inserted: result.inserted,
        }
        totalInserted += result.inserted
        filesUploaded++
      }
      saveState(state)
      if (filesUploaded > 0) {
        const dupeNote = ''
        onActivityRef.current(
          `Auto-import: ${totalInserted} new trades from ${filesUploaded} file${filesUploaded === 1 ? '' : 's'}${dupeNote}`,
          'success',
        )
        onImportedRef.current()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error'
      // Permission revoked or handle expired — drop back to disconnected state
      if (/not allowed|permission|invalid state/i.test(msg)) {
        onActivityRef.current(`Watcher disconnected: ${msg}`, 'error')
        setHandle(null)
        if (intervalRef.current) clearInterval(intervalRef.current)
        intervalRef.current = null
      } else {
        onActivityRef.current(`Watcher error: ${msg}`, 'error')
      }
    } finally {
      setPolling(false)
    }
  }, [])

  const connect = async () => {
    if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
      onActivity('File System Access API not supported — use Chrome or Edge', 'error')
      return
    }
    try {
      // @ts-expect-error — showDirectoryPicker is not in default TS DOM lib
      const h: FsHandle = await window.showDirectoryPicker({ id: 'sc-logs', mode: 'read' })
      setHandle(h)
      // First scan immediately
      await tick(h)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') return // user cancelled the picker
      onActivity(`Folder access denied: ${err.message}`, 'error')
    }
  }

  const disconnect = () => {
    setHandle(null)
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
  }

  // Set up periodic polling while connected
  useEffect(() => {
    if (!handle) return
    intervalRef.current = setInterval(() => { void tick(handle) }, POLL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [handle, tick])

  if (!handle) {
    return (
      <button
        onClick={connect}
        className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        title="Auto-import SC trade logs from a folder while this tab is open"
      >
        <Folder className="w-3 h-3" />
        Watch folder
      </button>
    )
  }

  const folderName = (handle as { name?: string }).name ?? 'folder'
  return (
    <div
      className="flex items-center gap-2 bg-green-900/20 border border-green-800 text-green-300 text-xs font-medium px-3 py-1.5 rounded-lg"
      title={`Polling ${folderName} every ${POLL_MS / 1000}s`}
    >
      {polling ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderCheck className="w-3 h-3" />}
      <span>Watching {folderName}</span>
      {lastCheck && (
        <span className="text-green-500/70">
          · {lastCheck.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      <button
        onClick={disconnect}
        className="text-green-500/70 hover:text-green-300 ml-1"
        title="Stop watching"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}
