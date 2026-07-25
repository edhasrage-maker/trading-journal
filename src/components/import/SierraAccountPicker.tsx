'use client'

import { useMemo, useState } from 'react'
import { Loader2, Search, Upload, X, Layers } from 'lucide-react'
import type { SierraAccount } from '@/lib/sc-accounts'

/**
 * Account chooser shown when a Sierra log carries more than one trade account
 * (a copy-trading / prop-firm export). The trader picks which account(s) to
 * import; the caller filters the raw text to the selection before uploading, so
 * only that account's fills leave the browser.
 *
 * Defaults to the last account(s) chosen (localStorage) or, first time, the most
 * active one — because a copy-trader imports the same account every week.
 */

const REMEMBER_KEY = 'sc-import-accounts'

function loadRemembered(): string[] {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY)
    const arr = raw ? JSON.parse(raw) : null
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

interface Props {
  accounts: SierraAccount[]
  busy?: boolean
  onCancel: () => void
  onConfirm: (selected: Set<string>) => void
  /** Combine ALL accounts into one portfolio journal (merges copy-traded
   *  decisions, totals size + P&L). When set, offered as the primary action. */
  onCombineAll?: () => void
}

export default function SierraAccountPicker({ accounts, busy, onCancel, onConfirm, onCombineAll }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => {
    const remembered = loadRemembered().filter(a => accounts.some(x => x.account === a))
    if (remembered.length > 0) return new Set(remembered)
    return new Set(accounts.length > 0 ? [accounts[0].account] : [])
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? accounts.filter(a => a.account.toLowerCase().includes(q)) : accounts
  }, [accounts, query])

  const totalFills = accounts.filter(a => selected.has(a.account)).reduce((n, a) => n + a.fills, 0)

  const toggle = (account: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(account)) next.delete(account); else next.add(account)
      return next
    })

  const confirm = () => {
    if (selected.size === 0) return
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify([...selected])) } catch { /* ignore */ }
    onConfirm(selected)
  }

  return (
    <div className="text-left rounded-xl border border-gray-800 bg-gray-950/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">This file has {accounts.length} trade accounts</h3>
          <p className="text-xs text-gray-400 mt-1 max-w-md">
            It looks like a copy-trading export — the same trades mirrored across every funded and eval
            account. Pick the account you want to journal; only its fills are uploaded.
          </p>
        </div>
        <button type="button" onClick={onCancel} className="text-gray-500 hover:text-gray-200 shrink-0" aria-label="Cancel">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Primary path: one portfolio journal across every account. */}
      {onCombineAll && (
        <div className="mt-3 rounded-lg border border-blue-800/60 bg-blue-950/25 p-3 flex items-center gap-3">
          <Layers className="w-5 h-5 text-blue-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Combine all {accounts.length} accounts</p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              One journal for your whole portfolio — total size &amp; P&amp;L per decision, full history, no duplicates.
            </p>
          </div>
          <button
            type="button"
            onClick={onCombineAll}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
            Combine all
          </button>
        </div>
      )}

      <p className="mt-3 text-[11px] font-medium text-gray-500 uppercase tracking-wider">Or import a specific account</p>

      <div className="mt-2 relative">
        <Search className="w-3.5 h-3.5 text-gray-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search accounts…"
          className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600"
        />
      </div>

      <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800/70">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-500 px-3 py-4 text-center">No accounts match &ldquo;{query}&rdquo;.</p>
        ) : filtered.map(a => {
          const on = selected.has(a.account)
          return (
            <label
              key={a.account}
              className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors ${on ? 'bg-blue-950/30' : 'hover:bg-gray-900'}`}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(a.account)} className="accent-blue-500 w-3.5 h-3.5 shrink-0" />
              <span className="font-mono text-[12px] text-gray-200 truncate flex-1">{a.account}</span>
              <span className="font-mono text-[11px] text-gray-500 tabular-nums shrink-0">{a.fills.toLocaleString()} fills</span>
            </label>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[11px] text-gray-500">
          {selected.size} account{selected.size === 1 ? '' : 's'} · {totalFills.toLocaleString()} fills selected
          {selected.size > 1 && <span className="text-amber-400/90"> — importing several accounts duplicates the shared trades</span>}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Cancel</button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy || selected.size === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {busy ? 'Importing…' : `Import ${selected.size === 1 ? 'this account' : `${selected.size} accounts`}`}
          </button>
        </div>
      </div>
    </div>
  )
}
