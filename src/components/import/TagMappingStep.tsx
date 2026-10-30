'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Tags } from 'lucide-react'
import { BUILTIN_TAG_CATEGORIES } from '@/lib/tag-categories'
import { newGroupTarget, type TagColumn, type TagMapEntry, type TagTarget } from '@/lib/import-tag-columns'

/**
 * "We found your tags" (docs/tapescore-onboarding-mockup-r2.html §①b): shown
 * after a trade CSV is picked and before it uploads, when the file has columns
 * that hold tags or notes. Each column already has a home — a built-in group
 * by name, notes, leave out, or a new group named after the column — so most
 * traders press one button. Shared by the first-run import card and /import.
 */

type Option = { value: string; label: string; target: TagTarget }

function encode(t: TagTarget): string {
  return t.kind === 'group' ? `g:${t.key}` : t.kind
}

export default function TagMappingStep({
  columns,
  busy,
  onConfirm,
  onSkip,
}: {
  columns: TagColumn[]
  busy?: boolean
  onConfirm: (map: TagMapEntry[]) => void
  onSkip: () => void
}) {
  // The trader's own groups, so a column can go into one they already have.
  const [custom, setCustom] = useState<{ key: string; label: string }[]>([])
  useEffect(() => {
    let alive = true
    fetch('/api/tag-categories')
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!alive || !j || !Array.isArray(j.categories)) return
        setCustom((j.categories as { key: string; label: string; builtin: boolean }[]).filter(c => !c.builtin))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const [choice, setChoice] = useState<Record<string, string>>(
    () => Object.fromEntries(columns.map(c => [c.header, encode(c.suggested)])),
  )

  const optionsFor = (c: TagColumn): Option[] => {
    const own = newGroupTarget(c.header)
    const opts: Option[] = BUILTIN_TAG_CATEGORIES.map(b => ({
      value: `g:${b.key}`, label: b.label, target: { kind: 'group', key: b.key, label: b.label, isNew: false },
    }))
    for (const g of custom) {
      if (opts.some(o => o.value === `g:${g.key}`)) continue
      opts.push({ value: `g:${g.key}`, label: g.label, target: { kind: 'group', key: g.key, label: g.label, isNew: false } })
    }
    if (own.kind === 'group' && !opts.some(o => o.value === `g:${own.key}`)) {
      opts.push({ value: `g:${own.key}`, label: `New group: “${own.label}”`, target: own })
    }
    opts.push({ value: 'notes', label: 'Each trade’s notes', target: { kind: 'notes' } })
    opts.push({ value: 'skip', label: 'Leave out', target: { kind: 'skip' } })
    return opts
  }

  const map: TagMapEntry[] = useMemo(() => columns.map(c => {
    const opt = optionsFor(c).find(o => o.value === choice[c.header])
    return { header: c.header, target: opt?.target ?? { kind: 'skip' } }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [columns, choice, custom])

  const groupCols = columns.filter((_, i) => map[i].target.kind === 'group')
  const tagCount = groupCols.reduce((n, c) => n + c.distinct, 0)
  const groupCount = new Set(map.flatMap(m => (m.target.kind === 'group' ? [m.target.key] : []))).size
  const newGroups = new Set(map.flatMap(m => (m.target.kind === 'group' && m.target.isNew ? [m.target.key] : []))).size
  const noteRows = columns.filter((_, i) => map[i].target.kind === 'notes').reduce((n, c) => Math.max(n, c.filled), 0)
  const nothing = tagCount === 0 && noteRows === 0

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-left">
      <div className="flex items-center gap-2">
        <Tags className="w-4 h-4 text-blue-400" />
        <h2 className="text-base font-semibold text-white">We found your tags</h2>
      </div>
      <p className="text-sm text-gray-400 mt-1">
        Each column goes into a group of tags. We&rsquo;ve sorted them; change any you like.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-gray-500">
              <th className="text-left font-semibold pb-2 pr-3">Your column</th>
              <th className="text-left font-semibold pb-2 pr-3">What&rsquo;s in it</th>
              <th className="text-left font-semibold pb-2">Goes to</th>
            </tr>
          </thead>
          <tbody>
            {columns.map(c => {
              const isNotes = choice[c.header] === 'notes'
              return (
                <tr key={c.header} className="border-t border-gray-800 align-middle">
                  <td className="py-2.5 pr-3 font-semibold text-gray-100 whitespace-nowrap">{c.header}</td>
                  <td className="py-2.5 pr-3 text-[12.5px] text-gray-400 min-w-[180px]">
                    {isNotes ? (
                      <>Text on {c.filled} trade{c.filled === 1 ? '' : 's'}</>
                    ) : (
                      <span className="flex flex-wrap gap-1 items-center">
                        {c.examples.map(e => (
                          <span key={e} className="px-1.5 rounded border border-gray-700 bg-gray-950 text-gray-300">{e}</span>
                        ))}
                        {c.distinct > c.examples.length && <span className="text-gray-500">+{c.distinct - c.examples.length}</span>}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5">
                    <select
                      value={choice[c.header]}
                      onChange={e => setChoice(prev => ({ ...prev, [c.header]: e.target.value }))}
                      disabled={busy}
                      aria-label={`Where ${c.header} goes`}
                      className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                    >
                      {optionsFor(c).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[13px] text-gray-400 mt-4">
        {nothing ? 'Nothing selected — only the trades will come in.' : (
          <>
            <b className="text-gray-200">{tagCount}</b> tag{tagCount === 1 ? '' : 's'} in <b className="text-gray-200">{groupCount}</b> group{groupCount === 1 ? '' : 's'}
            {newGroups > 0 && <> ({newGroups} new)</>}
            {noteRows > 0 && <> · notes on <b className="text-gray-200">{noteRows}</b> trade{noteRows === 1 ? '' : 's'}</>}
            . Tags you already have are matched, not doubled.
          </>
        )}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => onConfirm(map)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-white transition-colors"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {nothing ? 'Import the trades' : 'Bring them in'}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="text-sm text-gray-400 hover:text-gray-200 underline underline-offset-2 disabled:opacity-60"
        >
          Skip tags, just the trades
        </button>
      </div>
    </div>
  )
}
