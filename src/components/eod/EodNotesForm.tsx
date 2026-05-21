'use client'

import { useState } from 'react'
import { Save, Loader2 } from 'lucide-react'

interface Props {
  date: string
  initialNotes: string
  initialPnl: number | null
  computedPnl: number
  onSaved?: (notes: string, pnl: number | null) => void
  onError?: (msg: string) => void
}

export default function EodNotesForm({
  date,
  initialNotes,
  initialPnl,
  computedPnl,
  onSaved,
  onError,
}: Props) {
  const [notes, setNotes] = useState(initialNotes)
  const [pnl, setPnl] = useState<string>(initialPnl != null ? String(initialPnl) : '')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const parsedPnl = pnl.trim() === '' ? null : Number(pnl)
      const res = await fetch(`/api/trading-days/${date}/eod`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eod_notes: notes, eod_pnl: parsedPnl }),
      })
      if (!res.ok) {
        const err = await res.json()
        onError?.(`Save failed: ${err.error ?? 'unknown error'}`)
        return
      }
      setDirty(false)
      onSaved?.(notes, parsedPnl)
    } catch (e) {
      onError?.(`Save failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

  const overrideActive = pnl.trim() !== '' && Number(pnl) !== computedPnl

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">EOD Recap</h2>
        <div className="flex items-center gap-3">
          {dirty && !saving && (
            <span className="text-xs text-yellow-400 font-medium">Unsaved changes</span>
          )}
          <button
            onClick={save}
            disabled={saving}
            className={`flex items-center gap-2 font-medium px-4 py-2 rounded-lg text-sm transition-colors text-white disabled:opacity-60 ${
              dirty ? 'bg-yellow-600 hover:bg-yellow-500' : 'bg-blue-600 hover:bg-blue-500'
            }`}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Day Notes
        </label>
        <textarea
          value={notes}
          onChange={e => { setNotes(e.target.value); setDirty(true) }}
          rows={8}
          placeholder="Overall day assessment, execution quality, what went well, what to fix tomorrow..."
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Computed PnL <span className="text-xs text-gray-500">(sum of trades)</span>
          </label>
          <div
            className={`px-3 py-2 rounded-lg text-sm font-mono border ${
              computedPnl > 0
                ? 'border-green-700 bg-green-900/20 text-green-300'
                : computedPnl < 0
                ? 'border-red-700 bg-red-900/20 text-red-300'
                : 'border-gray-700 bg-gray-950 text-gray-400'
            }`}
          >
            {computedPnl >= 0 ? '+' : ''}{computedPnl.toFixed(2)}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            PnL Override <span className="text-xs text-gray-500">(optional)</span>
          </label>
          <input
            type="number"
            step="0.01"
            value={pnl}
            onChange={e => { setPnl(e.target.value); setDirty(true) }}
            placeholder="Leave blank to use computed"
            className={`w-full bg-gray-950 border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 ${
              overrideActive ? 'border-yellow-600' : 'border-gray-700'
            }`}
          />
        </div>
      </div>
    </div>
  )
}
