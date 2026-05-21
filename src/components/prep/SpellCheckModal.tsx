'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, X, Check, SpellCheck, Sparkles, Info } from 'lucide-react'
import { wordDiff, type DiffOp } from '@/lib/word-diff'
import type { SpellCheckCorrection } from '@/app/api/spell-check/route'

interface Props {
  open: boolean
  loading: boolean
  corrections: SpellCheckCorrection[]
  /** Map of correction.key → friendly label for the field */
  labels: Record<string, string>
  onApply: (toApply: SpellCheckCorrection[]) => void
  onClose: () => void
}

export default function SpellCheckModal(props: Props) {
  if (!props.open) return null
  // Re-mount the inner panel each time `corrections` changes so checkbox state
  // initializes cleanly via useState — avoids the "setState in effect" lint rule.
  const correctionsKey = props.corrections.map(c => c.key).join('|')
  return <Inner {...props} key={correctionsKey || 'empty'} />
}

function Inner({ loading, corrections, labels, onApply, onClose }: Props) {
  // Pre-check all fields with changes; user can toggle. Initializer runs once
  // because we re-mount the component when corrections change.
  const [checked, setChecked] = useState<Set<string>>(() => {
    const next = new Set<string>()
    for (const c of corrections) if (c.hasChanges) next.add(c.key)
    return next
  })

  // Esc to close
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) onClose() }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [loading, onClose])

  const changed = useMemo(() => corrections.filter(c => c.hasChanges), [corrections])
  const clean = useMemo(() => corrections.filter(c => !c.hasChanges), [corrections])
  const selectedCount = changed.filter(c => checked.has(c.key)).length

  const toggle = (key: string) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAll = () => setChecked(new Set(changed.map(c => c.key)))
  const selectNone = () => setChecked(new Set())

  const apply = () => {
    const toApply = changed.filter(c => checked.has(c.key))
    onApply(toApply)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-3xl w-full my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <SpellCheck className="w-4 h-4 text-blue-400" />
            <h3 className="font-semibold text-white">Spell Check</h3>
            {!loading && (
              <span className="text-xs text-gray-500 ml-2">
                {changed.length} field{changed.length === 1 ? '' : 's'} with suggestions ·{' '}
                {clean.length} already clean
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-12 text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Reviewing your prep notes...</span>
            </div>
          ) : changed.length === 0 ? (
            <div className="flex items-center justify-center gap-3 py-12 text-gray-400">
              <Sparkles className="w-4 h-4 text-green-400" />
              <span className="text-sm">No spelling or grammar issues found.</span>
            </div>
          ) : (
            <>
              {/* Confirmation hint */}
              <div className="mb-4 flex items-start gap-2 bg-blue-950/30 border border-blue-900/40 rounded-lg px-3 py-2 text-xs text-blue-200">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-blue-400" />
                <span>
                  Nothing changes in your prep until you click <span className="font-semibold">Apply</span>.
                  Uncheck any suggestion you want to keep as-is, or click <span className="font-semibold">Cancel</span> to discard them all.
                </span>
              </div>

              {/* Bulk toggles */}
              <div className="flex items-center gap-3 mb-4 text-xs">
                <span className="text-gray-500">{selectedCount} of {changed.length} selected</span>
                <button onClick={selectAll} className="text-blue-400 hover:text-blue-300 transition-colors">All</button>
                <span className="text-gray-700">·</span>
                <button onClick={selectNone} className="text-gray-400 hover:text-gray-200 transition-colors">None</button>
              </div>

              <div className="space-y-3">
                {changed.map(c => {
                  const label = labels[c.key] ?? c.key
                  const isChecked = checked.has(c.key)
                  return (
                    <div
                      key={c.key}
                      className={`border rounded-lg p-3 transition-colors ${
                        isChecked ? 'border-blue-700/60 bg-blue-950/20' : 'border-gray-800 bg-gray-950'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggle(c.key)}
                            className="accent-blue-600"
                          />
                          <span className="text-sm font-medium text-white">{label}</span>
                          {c.notes && (
                            <span className="text-xs text-gray-500 italic">— {c.notes}</span>
                          )}
                        </label>
                      </div>
                      <div className="ml-6">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-2">
                          Diff preview
                          <span className="text-gray-700 normal-case tracking-normal">
                            <span className="bg-red-900/40 text-red-300 line-through px-1 rounded">removed</span>{' '}
                            <span className="bg-green-900/40 text-green-300 px-1 rounded">added</span>
                          </span>
                        </div>
                        <DiffView original={c.original} corrected={c.corrected} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && changed.length > 0 && (
          <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-800">
            <button
              onClick={onClose}
              className="text-sm text-gray-400 hover:text-gray-200 px-3 py-1.5 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={selectedCount === 0}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900/40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              Apply {selectedCount} fix{selectedCount === 1 ? '' : 'es'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function DiffView({ original, corrected }: { original: string; corrected: string }) {
  const ops = useMemo<DiffOp[]>(() => wordDiff(original, corrected), [original, corrected])
  return (
    <div className="text-sm bg-gray-950 border border-gray-800 rounded px-3 py-2 whitespace-pre-wrap break-words leading-relaxed">
      {ops.map((op, i) => {
        if (op.type === 'eq') {
          return <span key={i} className="text-gray-300">{op.text}</span>
        }
        if (op.type === 'del') {
          return (
            <span
              key={i}
              className="bg-red-900/40 text-red-300 line-through decoration-red-500 decoration-1 rounded px-0.5"
            >
              {op.text}
            </span>
          )
        }
        return (
          <span key={i} className="bg-green-900/40 text-green-300 rounded px-0.5">
            {op.text}
          </span>
        )
      })}
    </div>
  )
}
