'use client'

import { useRef, useState } from 'react'
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

  const submit = async (file: File) => {
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
  }

  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={importing}
        className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
      >
        {importing ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Upload className="w-4 h-4" />
        )}
        {importing ? 'Importing...' : 'Import SC log'}
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
