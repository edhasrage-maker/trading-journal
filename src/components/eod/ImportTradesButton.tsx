'use client'

import { useCallback, useRef, useState } from 'react'
import { Upload, Loader2 } from 'lucide-react'

export interface ImportResult {
  inserted: number
  skippedDuplicates: number
  skippedFiltered: number
  parseErrors: string[]
  archivedAs?: string
  droppedColumns?: Record<string, string[]>
}

interface Props {
  date: string
  onImported: (result: ImportResult) => void
  onError: (msg: string) => void
}

export default function ImportTradesButton({ date, onImported, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)

  const submit = useCallback(async (file: File) => {
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('date', date)
      const res = await fetch('/api/import-sc-log', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        onError(`Import failed: ${data.error ?? 'unknown error'}`)
        return
      }
      onImported(data as ImportResult)
    } catch (e) {
      onError(`Import failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setImporting(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [date, onImported, onError])

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (!importing) setDragging(true)
  }
  const onDragLeave = () => setDragging(false)
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (importing) return
    const file = e.dataTransfer.files[0]
    if (file) submit(file)
  }

  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        disabled={importing}
        title="Click to pick a file, or drag-and-drop a TradeActivityLog .txt"
        className={`flex items-center gap-2 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-60 ${
          dragging
            ? 'bg-purple-400 ring-2 ring-purple-300'
            : 'bg-purple-600 hover:bg-purple-500'
        }`}
      >
        {importing ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Upload className="w-4 h-4" />
        )}
        {importing ? 'Importing...' : dragging ? 'Drop to import' : 'Import SC log'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.tsv,.csv"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) submit(f)
        }}
      />
    </>
  )
}
