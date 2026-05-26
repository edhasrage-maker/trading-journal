'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Trash2, Loader2, AlertTriangle, X } from 'lucide-react'

interface Props {
  date: string
  hasData: boolean
  tradesCount: number
  onError: (msg: string) => void
}

interface DeleteResult {
  deleted: boolean
  tradesDeleted: number
  blobsDeleted: number
  blobsAttempted: number
}

export default function DeleteDayDangerZone({ date, hasData, tradesCount, onError }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  if (!hasData) return null

  const submit = async () => {
    if (confirmText !== date) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/trading-days/${date}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: confirmText }),
      })
      if (!res.ok) {
        const err = await res.json()
        onError(`Delete failed: ${err.error ?? 'unknown'}`)
        setDeleting(false)
        return
      }
      const result = (await res.json()) as DeleteResult
      // Hard reload to clear all state and refetch from a clean slate
      router.replace('/calendar')
      router.refresh()
      // Tiny optimistic feedback before nav completes
      console.log(
        `[delete-day] ${date}: trades=${result.tradesDeleted} blobs=${result.blobsDeleted}/${result.blobsAttempted}`,
      )
    } catch (e) {
      onError(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`)
      setDeleting(false)
    }
  }

  return (
    <>
      {/* Danger zone card */}
      <section className="bg-red-950/20 border border-red-900/50 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-semibold text-red-300">Danger Zone</h3>
              <p className="text-xs text-red-200/80 mt-1 leading-relaxed">
                Permanently delete this entire day, including {tradesCount} trade{tradesCount === 1 ? '' : 's'},
                prep notes, market context, EOD chart, calibration, AI analyses, and all screenshots from storage.
                This cannot be undone.
              </p>
            </div>
          </div>
          <button
            onClick={() => setOpen(true)}
            className="shrink-0 flex items-center gap-1.5 bg-red-900/40 hover:bg-red-800 border border-red-800 text-red-200 hover:text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Delete day
          </button>
        </div>
      </section>

      {/* Type-to-confirm modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-gray-900 border border-red-900/60 rounded-xl shadow-2xl max-w-md w-full p-5">
            <div className="flex items-start justify-between mb-3">
              <h3 className="font-semibold text-red-300 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                Delete trading day
              </h3>
              <button
                onClick={() => { if (!deleting) { setOpen(false); setConfirmText('') } }}
                disabled={deleting}
                className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-30"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-gray-300 mb-4">
              You&apos;re about to permanently delete <span className="font-mono text-white">{date}</span> and every piece
              of data attached to it: {tradesCount} trade{tradesCount === 1 ? '' : 's'}, prep, market context,
              screenshots, calibration, EOD recap, and AI analyses.
            </p>

            <p className="text-xs text-gray-500 mb-2">
              Type <span className="font-mono text-red-300">{date}</span> to confirm:
            </p>
            <input
              type="text"
              autoFocus
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && confirmText === date && !deleting) submit()
              }}
              placeholder={date}
              disabled={deleting}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-red-500 font-mono"
            />

            <div className="flex justify-end gap-3 mt-5">
              <button
                onClick={() => { setOpen(false); setConfirmText('') }}
                disabled={deleting}
                className="text-sm text-gray-400 hover:text-gray-200 px-3 py-1.5 transition-colors disabled:opacity-30"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={confirmText !== date || deleting}
                className="flex items-center gap-2 bg-red-700 hover:bg-red-600 disabled:bg-red-900/50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {deleting ? 'Deleting...' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
