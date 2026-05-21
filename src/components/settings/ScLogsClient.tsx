'use client'

import { useEffect, useMemo, useState } from 'react'
import { Trash2, Loader2, FileText, AlertCircle, X, CheckSquare, Square } from 'lucide-react'
import { format } from 'date-fns'

export interface ScLogFile {
  name: string
  size: number
  created_at: string | null
  updated_at: string | null
}

interface Props {
  initialFiles: ScLogFile[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Try to extract a YYYY-MM-DD prefix from filenames like:
 *   "2026-05-01-1714571234-TradeActivityLog_2026-05-01.txt"
 * Falls back to null when no leading date is recognised.
 */
function extractDate(name: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(name)
  return m ? m[1] : null
}

interface ContextMenuState {
  x: number
  y: number
  fileName: string
}

export default function ScLogsClient({ initialFiles }: Props) {
  const [files, setFiles] = useState<ScLogFile[]>(initialFiles)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // Multi-select state
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  // Close context menu on any click outside or Esc
  useEffect(() => {
    if (!contextMenu) return
    const closeOnClick = () => setContextMenu(null)
    const closeOnEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null) }
    window.addEventListener('click', closeOnClick)
    window.addEventListener('keydown', closeOnEsc)
    return () => {
      window.removeEventListener('click', closeOnClick)
      window.removeEventListener('keydown', closeOnEsc)
    }
  }, [contextMenu])

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const allSelected = files.length > 0 && selected.size === files.length
  const someSelected = selected.size > 0 && !allSelected

  const indexByName = useMemo(() => {
    const m = new Map<string, number>()
    files.forEach((f, i) => m.set(f.name, i))
    return m
  }, [files])

  const toggleSelect = (name: string, idx: number, shiftKey: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (shiftKey && lastClickedIdx != null && lastClickedIdx !== idx) {
        const [from, to] = lastClickedIdx < idx ? [lastClickedIdx, idx] : [idx, lastClickedIdx]
        const target = !prev.has(name) // if current row will be selected after toggle, range gets selected; otherwise deselected
        for (let i = from; i <= to; i++) {
          const n = files[i].name
          if (target) next.add(n)
          else next.delete(n)
        }
      } else {
        if (next.has(name)) next.delete(name)
        else next.add(name)
      }
      return next
    })
    setLastClickedIdx(idx)
  }

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(files.map(f => f.name)))
  }

  const clearSelection = () => {
    setSelected(new Set())
    setLastClickedIdx(null)
  }

  const deleteOne = async (name: string) => {
    if (!confirm(`Delete "${name}" from sc-logs storage? This will not affect any imported trades — only removes the archived raw file.`)) return
    setDeleting(name)
    try {
      const res = await fetch('/api/screenshots', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [name], bucket: 'sc-logs' }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Delete failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      setFiles(prev => prev.filter(f => f.name !== name))
      setSelected(prev => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      showToast(`Deleted ${name}`, 'success')
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setDeleting(null)
    }
  }

  const deleteSelected = async () => {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} selected archive${selected.size === 1 ? '' : 's'}?`)) return
    const paths = Array.from(selected)
    setBulkDeleting(true)
    try {
      const res = await fetch('/api/screenshots', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, bucket: 'sc-logs' }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Bulk delete failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      const data = await res.json() as { deleted: number }
      const deletedNames = new Set(paths)
      setFiles(prev => prev.filter(f => !deletedNames.has(f.name)))
      setSelected(new Set())
      setLastClickedIdx(null)
      showToast(`Deleted ${data.deleted} archive${data.deleted === 1 ? '' : 's'}`, 'success')
    } catch (e) {
      showToast(`Bulk delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setBulkDeleting(false)
    }
  }

  const deleteOlderThan = async (days: number) => {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const toDelete = files.filter(f => {
      const ts = f.created_at ?? f.updated_at
      return ts ? new Date(ts).getTime() < cutoff : false
    })
    if (toDelete.length === 0) {
      showToast(`No files older than ${days} days`, 'success')
      return
    }
    if (!confirm(`Delete ${toDelete.length} archive${toDelete.length === 1 ? '' : 's'} older than ${days} days?`)) return
    setBulkDeleting(true)
    try {
      const res = await fetch('/api/screenshots', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: toDelete.map(f => f.name), bucket: 'sc-logs' }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Bulk delete failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      const data = await res.json() as { deleted: number }
      const deletedNames = new Set(toDelete.map(f => f.name))
      setFiles(prev => prev.filter(f => !deletedNames.has(f.name)))
      setSelected(prev => {
        const next = new Set(prev)
        for (const n of deletedNames) next.delete(n)
        return next
      })
      showToast(`Deleted ${data.deleted} archive${data.deleted === 1 ? '' : 's'}`, 'success')
    } catch (e) {
      showToast(`Bulk delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setBulkDeleting(false)
    }
  }

  const openContextMenu = (e: React.MouseEvent, fileName: string, idx: number) => {
    e.preventDefault()
    // Right-clicking a row that isn't selected starts a fresh single-row context.
    // If the row IS already selected, we leave the existing selection alone so
    // the user can act on the whole group.
    if (!selected.has(fileName)) {
      setSelected(new Set([fileName]))
      setLastClickedIdx(idx)
    }
    setContextMenu({ x: e.clientX, y: e.clientY, fileName })
  }

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <div>
        <h1 className="text-2xl font-bold text-white">Sierra Chart Log Archives</h1>
        <p className="text-gray-400 text-sm mt-1">
          Raw .txt exports archived during import. Deleting an archive does not remove imported trades — it only frees the storage.
        </p>
        <p className="text-xs text-gray-600 mt-2">
          <kbd className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5">Click</kbd> a checkbox to select ·{' '}
          <kbd className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5">Shift+Click</kbd> for range ·{' '}
          <kbd className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5">Right-click</kbd> a row for actions
        </p>
      </div>

      {/* Summary + bulk actions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-6 text-sm">
          <div>
            <div className="text-xs text-gray-500">Files</div>
            <div className="font-mono text-white text-lg">{files.length}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Total Size</div>
            <div className="font-mono text-white text-lg">{formatSize(totalBytes)}</div>
          </div>
          {selected.size > 0 && (
            <div>
              <div className="text-xs text-blue-400">Selected</div>
              <div className="font-mono text-blue-300 text-lg">{selected.size}</div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <button
                onClick={deleteSelected}
                disabled={bulkDeleting}
                className="flex items-center gap-1.5 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                Delete {selected.size} selected
              </button>
              <button
                onClick={clearSelection}
                disabled={bulkDeleting}
                className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5 transition-colors disabled:opacity-50"
              >
                Clear
              </button>
              <span className="border-l border-gray-700 h-5 mx-1" />
            </>
          )}
          <button
            onClick={() => deleteOlderThan(30)}
            disabled={bulkDeleting || files.length === 0}
            className="text-xs bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-800 text-gray-300 hover:text-red-200 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          >
            Delete &gt; 30 days old
          </button>
          <button
            onClick={() => deleteOlderThan(90)}
            disabled={bulkDeleting || files.length === 0}
            className="text-xs bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-800 text-gray-300 hover:text-red-200 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          >
            Delete &gt; 90 days old
          </button>
        </div>
      </div>

      {/* Files list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl">
        {files.length === 0 ? (
          <div className="p-8 text-center">
            <AlertCircle className="w-6 h-6 text-gray-600 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No SC log archives in storage.</p>
            <p className="text-xs text-gray-600 mt-1">
              Archives appear here when you upload an SC log via /eod or the folder watcher.
            </p>
          </div>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="w-10 py-2.5 px-3">
                  <button
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center text-gray-500 hover:text-blue-400 transition-colors"
                    title={allSelected ? 'Deselect all' : 'Select all'}
                  >
                    {allSelected
                      ? <CheckSquare className="w-3.5 h-3.5 text-blue-400" />
                      : someSelected
                        ? <span className="w-3.5 h-3.5 rounded-sm border border-blue-400 bg-blue-400/30 flex items-center justify-center"><span className="w-2 h-px bg-blue-400" /></span>
                        : <Square className="w-3.5 h-3.5" />}
                  </button>
                </th>
                <th className="text-left font-normal py-2.5 px-2">Trade Date</th>
                <th className="text-left font-normal py-2.5 px-4">Filename</th>
                <th className="text-right font-normal py-2.5 px-4">Size</th>
                <th className="text-left font-normal py-2.5 px-4">Uploaded</th>
                <th className="text-right font-normal py-2.5 px-4 pr-5"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => {
                const isSelected = selected.has(f.name)
                return (
                  <tr
                    key={f.name}
                    onContextMenu={e => openContextMenu(e, f.name, i)}
                    className={`border-b border-gray-800/50 transition-colors ${
                      isSelected ? 'bg-blue-950/30 hover:bg-blue-950/50' : 'hover:bg-gray-800/40'
                    }`}
                  >
                    <td className="w-10 py-2 px-3 text-center">
                      <button
                        onClick={e => toggleSelect(f.name, i, e.shiftKey)}
                        className="flex items-center justify-center text-gray-500 hover:text-blue-400 transition-colors"
                      >
                        {isSelected
                          ? <CheckSquare className="w-3.5 h-3.5 text-blue-400" />
                          : <Square className="w-3.5 h-3.5" />}
                      </button>
                    </td>
                    <td className="py-2 px-2 text-gray-300">{extractDate(f.name) ?? '—'}</td>
                    <td className="py-2 px-4 text-gray-400 truncate max-w-md">
                      <span className="flex items-center gap-2">
                        <FileText className="w-3 h-3 text-gray-600 shrink-0" />
                        <span className="truncate" title={f.name}>{f.name}</span>
                      </span>
                    </td>
                    <td className="py-2 px-4 text-right text-gray-400">{formatSize(f.size)}</td>
                    <td className="py-2 px-4 text-gray-500">
                      {f.created_at ? format(new Date(f.created_at), 'MMM d, yyyy HH:mm') : '—'}
                    </td>
                    <td className="py-2 px-4 pr-5 text-right">
                      <button
                        onClick={() => deleteOne(f.name)}
                        disabled={deleting === f.name}
                        className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-30"
                        title="Delete this archive"
                      >
                        {deleting === f.name
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          fileName={contextMenu.fileName}
          selectedCount={selected.size}
          onSelectAll={() => { setSelected(new Set(files.map(f => f.name))); setContextMenu(null) }}
          onClearSelection={() => { clearSelection(); setContextMenu(null) }}
          onDeleteThis={() => {
            const name = contextMenu.fileName
            setContextMenu(null)
            void deleteOne(name)
          }}
          onDeleteSelected={() => { setContextMenu(null); void deleteSelected() }}
          onAddToSelection={() => {
            // already in selection; this is a no-op visually but closes the menu
            setContextMenu(null)
          }}
          onSelectByDate={() => {
            const date = extractDate(contextMenu.fileName)
            if (date) {
              const matching = files.filter(f => extractDate(f.name) === date).map(f => f.name)
              setSelected(prev => new Set([...prev, ...matching]))
              const firstIdx = files.findIndex(f => matching.includes(f.name))
              setLastClickedIdx(firstIdx >= 0 ? firstIdx : null)
            }
            setContextMenu(null)
          }}
          hasDate={extractDate(contextMenu.fileName) != null}
          // referenced for type narrowing; suppress unused
          indexByName={indexByName}
        />
      )}
    </div>
  )
}

interface ContextMenuProps {
  x: number
  y: number
  fileName: string
  selectedCount: number
  onSelectAll: () => void
  onClearSelection: () => void
  onDeleteThis: () => void
  onDeleteSelected: () => void
  onAddToSelection: () => void
  onSelectByDate: () => void
  hasDate: boolean
  indexByName: Map<string, number>
}

function ContextMenu({
  x, y, fileName, selectedCount,
  onSelectAll, onClearSelection, onDeleteThis, onDeleteSelected, onAddToSelection, onSelectByDate, hasDate,
}: ContextMenuProps) {
  // Clamp into viewport so the menu doesn't render off-screen
  const MENU_W = 220, MENU_H = 240
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1024) - MENU_W - 8)
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 768) - MENU_H - 8)

  // Stop the global click listener from immediately closing us when this mounts
  return (
    <div
      className="fixed bg-gray-900 border border-gray-700 rounded-lg shadow-2xl py-1 text-xs z-50 min-w-[14rem]"
      style={{ left, top }}
      onClick={e => e.stopPropagation()}
    >
      <div className="px-3 py-2 text-gray-500 border-b border-gray-800 truncate" title={fileName}>
        {fileName}
      </div>

      <MenuItem onClick={onAddToSelection}>
        <CheckSquare className="w-3 h-3" /> Selected ({selectedCount})
      </MenuItem>

      {hasDate && (
        <MenuItem onClick={onSelectByDate}>
          <CheckSquare className="w-3 h-3" /> Select all from same date
        </MenuItem>
      )}

      <MenuItem onClick={onSelectAll}>
        <CheckSquare className="w-3 h-3" /> Select all
      </MenuItem>

      {selectedCount > 0 && (
        <MenuItem onClick={onClearSelection}>
          <X className="w-3 h-3" /> Clear selection
        </MenuItem>
      )}

      <div className="my-1 border-t border-gray-800" />

      <MenuItem danger onClick={onDeleteThis}>
        <Trash2 className="w-3 h-3" /> Delete this file
      </MenuItem>
      {selectedCount > 1 && (
        <MenuItem danger onClick={onDeleteSelected}>
          <Trash2 className="w-3 h-3" /> Delete {selectedCount} selected
        </MenuItem>
      )}
    </div>
  )
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
        danger
          ? 'text-red-300 hover:bg-red-900/40'
          : 'text-gray-300 hover:bg-gray-800'
      }`}
    >
      {children}
    </button>
  )
}
