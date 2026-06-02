'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Tag as TagIcon, Loader2, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Combine } from 'lucide-react'

const CATEGORIES = ['setups', 'confluences', 'order_flow', 'trade_management', 'day_type', 'mistakes', 'emotions'] as const
type Category = typeof CATEGORIES[number]

const CATEGORY_LABELS: Record<Category, string> = {
  setups: 'Setups',
  confluences: 'Confluences',
  order_flow: 'Order Flow',
  trade_management: 'Trade Management',
  day_type: 'Day Type',
  mistakes: 'Mistakes',
  emotions: 'Emotions',
}

interface TagRow { id: string; label: string; usage: number; orphan: boolean }
interface CategoryStats { tags: TagRow[]; clusters: string[][] }
type Stats = Record<Category, CategoryStats>

interface MergeResult {
  category: Category
  canonical: string
  victims: string[]
  tradesUpdated: number
  historicalUpdated: number
  trade_tagsDeleted: number
  errors: string[]
}

export default function TagsClient() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openCat, setOpenCat] = useState<Category | null>('setups')
  // Per-category: which labels are currently checked (for manual cluster building).
  const [selected, setSelected] = useState<Record<Category, Set<string>>>(() =>
    Object.fromEntries(CATEGORIES.map(c => [c, new Set<string>()])) as Record<Category, Set<string>>,
  )
  const [canonicalPick, setCanonicalPick] = useState<Record<Category, string>>(() =>
    Object.fromEntries(CATEGORIES.map(c => [c, ''])) as Record<Category, string>,
  )
  const [filter, setFilter] = useState<Record<Category, string>>(() =>
    Object.fromEntries(CATEGORIES.map(c => [c, ''])) as Record<Category, string>,
  )
  const [merging, setMerging] = useState(false)
  const [lastResult, setLastResult] = useState<MergeResult | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/tags/stats')
      const d = await r.json()
      if (!r.ok) { setError(d.error ?? 'Failed to load tag stats'); return }
      setStats(d as Stats)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load on mount; refresh() is stable via useCallback
  useEffect(() => { refresh() }, [refresh])

  const toggleSelect = (cat: Category, label: string) => {
    setSelected(prev => {
      const next = new Set(prev[cat])
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return { ...prev, [cat]: next }
    })
    // If user unticks the current canonical, clear it.
    setCanonicalPick(prev => {
      const stillSelected = new Set(selected[cat])
      // toggle effect (we haven't applied the new state yet; mimic it)
      if (stillSelected.has(label)) stillSelected.delete(label)
      else stillSelected.add(label)
      return prev[cat] === label && !stillSelected.has(label) ? { ...prev, [cat]: '' } : prev
    })
  }

  const applyCluster = (cat: Category, labels: string[]) => {
    setSelected(prev => ({ ...prev, [cat]: new Set(labels) }))
    // Pre-pick the most-used label as canonical.
    if (!stats) return
    const ranked = stats[cat].tags
      .filter(t => labels.includes(t.label))
      .sort((a, b) => b.usage - a.usage)
    setCanonicalPick(prev => ({ ...prev, [cat]: ranked[0]?.label ?? labels[0] }))
  }

  const clearSelection = (cat: Category) => {
    setSelected(prev => ({ ...prev, [cat]: new Set() }))
    setCanonicalPick(prev => ({ ...prev, [cat]: '' }))
  }

  const runMerge = async (cat: Category) => {
    const canonical = canonicalPick[cat]
    const sel = selected[cat]
    const victims = Array.from(sel).filter(l => l !== canonical)
    if (!canonical || victims.length === 0) return
    if (!confirm(`Merge ${victims.length} tag${victims.length === 1 ? '' : 's'} into "${canonical}"?\n\nVictims:\n  ${victims.join('\n  ')}`)) return
    setMerging(true)
    setLastResult(null)
    try {
      const r = await fetch('/api/tags/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: cat, canonical, victims }),
      })
      const data = await r.json()
      if (!r.ok) { setError(data.error ?? 'Merge failed'); return }
      setLastResult(data as MergeResult)
      clearSelection(cat)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setMerging(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    )
  }
  if (error && !stats) {
    return (
      <div className="max-w-4xl mx-auto bg-red-950/30 border border-red-900 rounded-xl p-4 text-red-200">
        <AlertTriangle className="inline w-4 h-4 mr-1" /> {error}
      </div>
    )
  }
  if (!stats) return null

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <TagIcon className="w-6 h-6 text-blue-400" />
          Tag Management
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          Fold duplicate or near-duplicate tags into a single canonical label. Rewrites
          every <span className="font-mono">tags_json</span> in <span className="font-mono">trades</span>
          and <span className="font-mono">historical_trades</span>, then removes the victim
          rows from the tag library. Click a category to expand.
        </p>
      </div>

      {lastResult && (
        <div className="bg-green-950/40 border border-green-800/60 rounded-lg p-3 text-sm text-green-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            Merged {lastResult.victims.length} tag{lastResult.victims.length === 1 ? '' : 's'} into
            <span className="font-mono"> &quot;{lastResult.canonical}&quot; </span>
            ({CATEGORY_LABELS[lastResult.category]}).
            Updated <strong>{lastResult.tradesUpdated}</strong> trades + <strong>{lastResult.historicalUpdated}</strong> historical,
            removed <strong>{lastResult.trade_tagsDeleted}</strong> library row{lastResult.trade_tagsDeleted === 1 ? '' : 's'}.
            {lastResult.errors.length > 0 && (
              <ul className="mt-1 text-[11px] text-yellow-200/80 list-disc pl-4">
                {lastResult.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      {CATEGORIES.map(cat => {
        const isOpen = openCat === cat
        const data = stats[cat]
        const sel = selected[cat]
        const canon = canonicalPick[cat]
        const f = filter[cat].trim().toLowerCase()
        const filtered = f ? data.tags.filter(t => t.label.toLowerCase().includes(f)) : data.tags
        const canMerge = !!canon && sel.size >= 2 && sel.has(canon)

        return (
          <div key={cat} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setOpenCat(o => o === cat ? null : cat)}
              className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-900/60"
            >
              <div className="flex items-center gap-2">
                {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                <span className="font-semibold text-white text-sm">{CATEGORY_LABELS[cat]}</span>
                <span className="text-xs text-gray-500">{data.tags.length} tag{data.tags.length === 1 ? '' : 's'}</span>
                {data.clusters.length > 0 && (
                  <span className="text-[11px] text-yellow-300/80 bg-yellow-950/30 border border-yellow-900/40 rounded px-1.5 py-0.5">
                    {data.clusters.length} suggested merge{data.clusters.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-gray-800 p-4 space-y-4">
                {/* Suggested duplicate clusters */}
                {data.clusters.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-400">Suggested duplicate clusters (auto-detected from looseKey collisions):</p>
                    <div className="flex flex-wrap gap-2">
                      {data.clusters.map((cluster, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => applyCluster(cat, cluster)}
                          className="text-xs bg-yellow-950/30 border border-yellow-900/50 hover:border-yellow-700/60 text-yellow-200 rounded px-2 py-1 transition-colors"
                          title="Select all labels in this cluster"
                        >
                          {cluster.map(l => `"${l}"`).join(' · ')}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Merge controls */}
                <div className="bg-gray-950/40 border border-gray-800 rounded-lg p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-gray-400">Canonical:</span>
                    <select
                      value={canon}
                      onChange={e => setCanonicalPick(prev => ({ ...prev, [cat]: e.target.value }))}
                      className="bg-gray-800 border border-gray-700 text-white rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                    >
                      <option value="">— pick canonical from selection —</option>
                      {Array.from(sel).sort().map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-400">{sel.size} selected</span>
                    {sel.size > 0 && (
                      <button type="button" onClick={() => clearSelection(cat)} className="text-gray-500 hover:text-white ml-1">Clear</button>
                    )}
                    <div className="flex-grow" />
                    <button
                      type="button"
                      onClick={() => runMerge(cat)}
                      disabled={!canMerge || merging}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1 rounded transition-colors flex items-center gap-1"
                    >
                      {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <Combine className="w-3 h-3" />}
                      Merge {sel.size > 0 ? `${sel.size - (sel.has(canon) ? 1 : 0)} → 1` : ''}
                    </button>
                  </div>
                  <p className="text-[10px] text-gray-500">
                    Tick 2 or more labels, then pick which one to keep. Victims are folded into the
                    canonical across both trades and historical_trades and removed from the library.
                  </p>
                </div>

                {/* Filter + tag list */}
                <input
                  type="text"
                  value={filter[cat]}
                  onChange={e => setFilter(prev => ({ ...prev, [cat]: e.target.value }))}
                  placeholder={`Filter ${CATEGORY_LABELS[cat]}…`}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
                />
                <TagGrid tags={filtered} selected={sel} onToggle={l => toggleSelect(cat, l)} canonical={canon} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TagGrid({
  tags,
  selected,
  onToggle,
  canonical,
}: {
  tags: TagRow[]
  selected: Set<string>
  onToggle: (label: string) => void
  canonical: string
}) {
  const maxUsage = useMemo(() => Math.max(1, ...tags.map(t => t.usage)), [tags])
  if (tags.length === 0) {
    return <p className="text-xs text-gray-500">No tags match the filter.</p>
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
      {tags.map(t => {
        const isSel = selected.has(t.label)
        const isCanon = canonical === t.label
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onToggle(t.label)}
            className={`relative text-left text-xs rounded px-2 py-1.5 border transition-colors ${
              isCanon ? 'border-green-700 bg-green-950/30 text-green-200'
              : isSel ? 'border-blue-700 bg-blue-950/30 text-blue-200'
              : t.orphan ? 'border-yellow-900/50 bg-gray-900 text-yellow-200/80 hover:border-yellow-700'
              : 'border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-600'
            }`}
            title={t.orphan ? 'Orphan: appears in trades but not in trade_tags library' : `${t.usage} uses`}
          >
            <span className="block truncate">{t.label}</span>
            <span className="block text-[10px] text-gray-500 font-mono">{t.usage} use{t.usage === 1 ? '' : 's'}{t.orphan ? ' · orphan' : ''}</span>
            {/* usage bar */}
            <span
              className="absolute left-0 bottom-0 h-0.5 bg-blue-500/50"
              style={{ width: `${(t.usage / maxUsage) * 100}%` }}
            />
          </button>
        )
      })}
    </div>
  )
}
