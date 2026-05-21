'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { TrendingUp, TrendingDown, Minus, Trash2, Loader2 } from 'lucide-react'
import type { TradingDay } from '@/lib/supabase/types'

type DayRow = Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type'>

interface Props {
  initialDays: DayRow[]
}

export default function RecentDaysList({ initialDays }: Props) {
  const router = useRouter()
  const [days, setDays] = useState<DayRow[]>(initialDays)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const handleDelete = async (date: string, hasData: boolean) => {
    const msg = hasData
      ? `Delete ${date}? This permanently removes all trades, prep, screenshots, calibration, and EOD data for this day.`
      : `Delete ${date} from your journal? (No PnL recorded — likely just a prep entry.)`
    if (!confirm(msg)) return

    setDeleting(date)
    try {
      const res = await fetch(`/api/trading-days/${date}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: date }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Delete failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      setDays(prev => prev.filter(d => d.date !== date))
      showToast(`Deleted ${date}`, 'success')
      router.refresh() // refresh the 30d stat cards above the list
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setDeleting(null)
    }
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
      <div className="space-y-1">
        {days.map(day => (
          <DayRowItem
            key={day.id}
            day={day}
            deleting={deleting === day.date}
            onDelete={() => handleDelete(day.date, day.eod_pnl != null)}
          />
        ))}
      </div>
    </>
  )
}

function DayRowItem({
  day,
  deleting,
  onDelete,
}: {
  day: DayRow
  deleting: boolean
  onDelete: () => void
}) {
  const pnl = day.eod_pnl
  const pnlColor = pnl === null ? 'text-gray-500' : pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'
  const Icon = pnl === null ? Minus : pnl > 0 ? TrendingUp : pnl < 0 ? TrendingDown : Minus

  return (
    <div className="group relative flex items-center rounded-lg hover:bg-gray-800 transition-colors">
      <Link
        href={`/eod/${day.date}`}
        className="flex-1 flex items-center justify-between px-3 py-2.5"
      >
        <div className="flex items-center gap-3">
          <Icon className={`w-4 h-4 ${pnlColor}`} />
          <span className="text-sm text-white">{format(new Date(day.date + 'T12:00:00'), 'EEE, MMM d')}</span>
          {day.day_type && (
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">{day.day_type}</span>
          )}
        </div>
        <span className={`text-sm font-medium ${pnlColor}`}>
          {pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}$${pnl.toLocaleString()}`}
        </span>
      </Link>
      <button
        onClick={onDelete}
        disabled={deleting}
        className="px-3 py-2.5 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30 disabled:cursor-wait"
        title={`Delete ${day.date}`}
      >
        {deleting
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Trash2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}
