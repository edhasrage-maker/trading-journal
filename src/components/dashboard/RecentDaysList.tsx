'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { TrendingUp, TrendingDown, Minus, Trash2, Loader2, Check } from 'lucide-react'

export interface DayRowData {
  id: string
  date: string
  eod_pnl: number | null
  day_type: string | null
  trade_count: number
  main_setups: string[]
  process_score: number | null
  overall_grade: number | null
}

interface Props {
  initialDays: DayRowData[]
}

export default function RecentDaysList({ initialDays }: Props) {
  const router = useRouter()
  const [days, setDays] = useState<DayRowData[]>(initialDays)
  const [deletingDate, setDeletingDate] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const deleteOne = async (date: string): Promise<boolean> => {
    const res = await fetch(`/api/trading-days/${date}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: date }),
    })
    return res.ok
  }

  const handleSingleDelete = async (date: string, hasData: boolean) => {
    const msg = hasData
      ? `Delete ${date}? This permanently removes all trades, prep, screenshots, calibration, and EOD data for this day.`
      : `Delete ${date} from your journal? (No PnL recorded — likely just a prep entry.)`
    if (!confirm(msg)) return

    setDeletingDate(date)
    try {
      const ok = await deleteOne(date)
      if (!ok) {
        showToast(`Delete failed for ${date}`, 'error')
        return
      }
      setDays(prev => prev.filter(d => d.date !== date))
      showToast(`Deleted ${date}`, 'success')
      router.refresh()
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setDeletingDate(null)
    }
  }

  const handleBulkDelete = async () => {
    const selected = days.filter(d => selectedIds.has(d.id))
    if (selected.length === 0) return

    const proceed = confirm(
      `Delete ${selected.length} day${selected.length === 1 ? '' : 's'}?\n\n` +
        selected.map(d => `  • ${d.date}${d.eod_pnl != null ? ` (PnL ${d.eod_pnl >= 0 ? '+' : ''}$${d.eod_pnl})` : ''}`).join('\n') +
        `\n\nThis permanently removes all trades, prep, screenshots, calibration, and EOD data ` +
        `for each selected day. Cannot be undone.`,
    )
    if (!proceed) return

    setBulkDeleting(true)
    const succeeded: string[] = []
    const failed: string[] = []
    for (const d of selected) {
      try {
        const ok = await deleteOne(d.date)
        if (ok) succeeded.push(d.date)
        else failed.push(d.date)
      } catch {
        failed.push(d.date)
      }
    }
    setDays(prev => prev.filter(d => !succeeded.includes(d.date)))
    clearSelection()
    setBulkDeleting(false)

    if (failed.length === 0) {
      showToast(`Deleted ${succeeded.length} day${succeeded.length === 1 ? '' : 's'}`, 'success')
    } else if (succeeded.length === 0) {
      showToast(`All ${failed.length} deletes failed`, 'error')
    } else {
      showToast(`Deleted ${succeeded.length}, ${failed.length} failed`, 'error')
    }
    router.refresh()
  }

  if (days.length === 0) {
    return (
      <p className="text-gray-500 text-sm">No trading days yet. Start by completing your daily prep.</p>
    )
  }

  return (
    <>
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mb-3 bg-red-950/60 border border-red-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-sm">
          <span className="text-red-200">
            {selectedIds.size} day{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkDeleting}
              className="text-xs text-red-300 hover:text-white disabled:opacity-50"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
            >
              {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              {bulkDeleting ? 'Deleting…' : 'Delete selected'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {days.map(day => (
          <DayRowItem
            key={day.id}
            day={day}
            selected={selectedIds.has(day.id)}
            deleting={deletingDate === day.date || (bulkDeleting && selectedIds.has(day.id))}
            onToggleSelect={() => toggleSelect(day.id)}
            onDelete={() => handleSingleDelete(day.date, day.eod_pnl != null)}
          />
        ))}
      </div>
    </>
  )
}

function DayRowItem({
  day,
  selected,
  deleting,
  onToggleSelect,
  onDelete,
}: {
  day: DayRowData
  selected: boolean
  deleting: boolean
  onToggleSelect: () => void
  onDelete: () => void
}) {
  const pnl = day.eod_pnl
  const pnlColor = pnl === null ? 'text-gray-500' : pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'
  const Icon = pnl === null ? Minus : pnl > 0 ? TrendingUp : pnl < 0 ? TrendingDown : Minus

  return (
    <div className={`group relative flex items-center rounded-lg transition-colors ${
      selected ? 'bg-blue-950/40 border border-blue-800/60' : 'border border-transparent hover:bg-gray-800'
    }`}>
      {/* Select checkbox — outside the Link so clicks don't navigate */}
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onToggleSelect() }}
        className={`ml-2 mr-1 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0 ${
          selected
            ? 'bg-blue-600 border-blue-500 text-white'
            : 'border-gray-600 hover:border-gray-400 bg-gray-900'
        }`}
        title={selected ? 'Deselect' : 'Select for bulk action'}
      >
        {selected ? <Check className="w-3 h-3" /> : null}
      </button>

      <Link
        href={`/eod/${day.date}`}
        className="flex-1 flex items-center justify-between px-2 py-2 gap-3 min-w-0"
      >
        {/* Left cluster: trend icon, date, day type */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <Icon className={`w-4 h-4 ${pnlColor}`} />
          <span className="text-sm text-white font-medium w-[6.5rem]">{format(new Date(day.date + 'T12:00:00'), 'EEE, MMM d')}</span>
          {day.day_type ? (
            <span className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded-full whitespace-nowrap">{day.day_type}</span>
          ) : (
            <span className="text-[10px] text-gray-700 w-16" />
          )}
        </div>

        {/* Middle cluster: trade count, setups */}
        <div className="flex items-center gap-3 text-xs flex-1 min-w-0">
          <span className="text-gray-400 font-mono flex-shrink-0 w-12 text-right">
            {day.trade_count > 0 ? `${day.trade_count} tr` : <span className="text-gray-700">—</span>}
          </span>
          <span className="text-gray-400 truncate min-w-0 flex-1">
            {day.main_setups.length > 0
              ? day.main_setups.join(' · ')
              : <span className="text-gray-700">—</span>}
          </span>
        </div>

        {/* Right cluster: scores + pnl */}
        <div className="flex items-center gap-3 text-xs flex-shrink-0">
          <ScorePill label="Pr" value={day.process_score} />
          <ScorePill label="Gr" value={day.overall_grade} />
          <span className={`text-sm font-medium font-mono w-20 text-right ${pnlColor}`}>
            {pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}$${pnl.toLocaleString()}`}
          </span>
        </div>
      </Link>

      {/* Delete button — outside the Link */}
      <button
        onClick={onDelete}
        disabled={deleting}
        className="px-3 py-2.5 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30 disabled:cursor-wait flex-shrink-0"
        title={`Delete ${day.date}`}
      >
        {deleting
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Trash2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

function ScorePill({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return <span className="text-gray-700 font-mono w-12 text-center">{label} —</span>
  }
  // 0-100 scale; color by band
  const color =
    value >= 80 ? 'text-green-400 border-green-800/50 bg-green-950/40'
    : value >= 60 ? 'text-blue-300 border-blue-800/50 bg-blue-950/40'
    : value >= 40 ? 'text-yellow-300 border-yellow-800/50 bg-yellow-950/40'
    : 'text-red-300 border-red-800/50 bg-red-950/40'
  return (
    <span className={`font-mono border rounded px-1.5 py-0.5 w-12 text-center ${color}`}>
      {label} {value}
    </span>
  )
}
