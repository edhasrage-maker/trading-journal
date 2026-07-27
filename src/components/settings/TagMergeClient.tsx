'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, ArrowRight, Loader2, GitMerge, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import type { TagCategory, TradeTag } from '@/lib/supabase/types'
import { labelForCategory, type TagCategoryDef } from '@/lib/tag-categories'
import { invalidateTagCategories } from '@/lib/tag-categories-client'

interface Props {
  tags: TradeTag[]
  /** Keyed by `${category}|${label}`; missing keys = 0. */
  usage: Record<string, number>
  /** The trader's own category list (Pt 16) — built-ins they've kept, plus any
   *  axis they added. Server-resolved so first paint is already correct. */
  categories: TagCategoryDef[]
  /** Built-ins they've removed, offered back in a restore row. */
  hidden: TagCategoryDef[]
}

/** Levenshtein distance. Capped at `max+1` for cheap "is it close enough" checks. */
function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const dp = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) dp[j] = j
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    let rowMin = dp[0]
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
      if (dp[j] < rowMin) rowMin = dp[j]
    }
    // Early exit if best in row already exceeds max.
    if (rowMin > max) return max + 1
  }
  return dp[b.length]
}

interface Suggestion {
  category: TagCategory
  a: TradeTag
  b: TradeTag
  distance: number
}

/** Extract the set of numeric tokens from a label so we can suppress
 *  pairs like "9 EMA Hold" vs "20 EMA Hold" or "2nd Attempt" vs "3rd
 *  Attempt" — Levenshtein-only would flag those at distance ≤2 even
 *  though they're semantically distinct (different EMAs, different
 *  attempts). If the labels contain DIFFERENT numbers, they're almost
 *  certainly distinct tags and shouldn't be offered as merge candidates. */
function extractNumbers(s: string): Set<string> {
  const nums = s.match(/\d+/g)
  return new Set(nums ?? [])
}

function numberSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function suggestPairs(tags: TradeTag[], threshold: number): Suggestion[] {
  const byCat: Record<string, TradeTag[]> = {}
  for (const t of tags) {
    if (!byCat[t.category]) byCat[t.category] = []
    byCat[t.category].push(t)
  }
  const pairs: Suggestion[] = []
  for (const cat of Object.keys(byCat) as TagCategory[]) {
    const list = byCat[cat]
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        // Pre-filter: if the labels contain different numeric tokens, they're
        // distinct (e.g. 9 EMA vs 20 EMA, 2nd vs 3rd). Skip without scoring.
        const numsA = extractNumbers(list[i].label)
        const numsB = extractNumbers(list[j].label)
        if (!numberSetsEqual(numsA, numsB)) continue
        const d = levenshtein(list[i].label.toLowerCase(), list[j].label.toLowerCase(), threshold)
        if (d <= threshold && d > 0) {
          pairs.push({ category: cat, a: list[i], b: list[j], distance: d })
        }
      }
    }
  }
  pairs.sort((x, y) => x.distance - y.distance)
  return pairs
}

type MergeIntent = { from: TradeTag; to: TradeTag } | null

interface MergeResponse {
  ok?: true
  trades_updated?: number
  historical_updated?: number
  from_label?: string
  to_label?: string
  category?: TagCategory
  error?: string
}

export default function TagMergeClient({
  tags: initialTags, usage: initialUsage, categories: initialCategories, hidden: initialHidden,
}: Props) {
  const router = useRouter()
  const [tags, setTags] = useState(initialTags)
  const [usage, setUsage] = useState(initialUsage)
  // Category list state — mirrored locally so add/remove/rename update without
  // a round-trip through the server component.
  const [cats, setCats] = useState<TagCategoryDef[]>(initialCategories)
  const [hiddenCats, setHiddenCats] = useState<TagCategoryDef[]>(initialHidden)
  const [newCatOpen, setNewCatOpen] = useState(false)
  const [newCatDraft, setNewCatDraft] = useState('')
  const [catBusy, setCatBusy] = useState<string | null>(null)   // category key or '__new__'
  const [catError, setCatError] = useState<string | null>(null)
  const [catResult, setCatResult] = useState<string | null>(null)
  const [renamingCat, setRenamingCat] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [intent, setIntent] = useState<MergeIntent>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<MergeResponse | null>(null)
  const [manualCategory, setManualCategory] = useState<TagCategory>(() => initialCategories[0]?.key ?? 'setups')
  const [manualFrom, setManualFrom] = useState<string>('')
  const [manualTo, setManualTo] = useState<string>('')
  // Move-tag state: pick a source category, pick a tag from it, pick the
  // destination category. Independent of the merge state above.
  const [moveSrcCategory, setMoveSrcCategory] = useState<TagCategory>(() => initialCategories[0]?.key ?? 'setups')
  const [moveTagId, setMoveTagId] = useState<string>('')
  const [moveDstCategory, setMoveDstCategory] = useState<TagCategory>(() => initialCategories[1]?.key ?? 'confluences')
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveResult, setMoveResult] = useState<string | null>(null)
  // Delete-tag state: which chip is mid-delete, plus a result banner.
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null)
  const [deleteResult, setDeleteResult] = useState<string | null>(null)

  // Add-tag: which category's inline "+ Add tag" input is open + its draft.
  const [addingCat, setAddingCat] = useState<TagCategory | null>(null)
  const [addDraft, setAddDraft] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const suggestions = useMemo(() => suggestPairs(tags, 2), [tags])

  const usageFor = (t: TradeTag): number => usage[`${t.category}|${t.label}`] ?? 0
  const labelOf = (key: string): string => labelForCategory(key, cats)

  const byCategory = useMemo(() => {
    const m: Record<string, TradeTag[]> = {}
    for (const t of tags) {
      if (!m[t.category]) m[t.category] = []
      m[t.category].push(t)
    }
    return m
  }, [tags])

  const suggestionsByCategory = useMemo(() => {
    const m: Record<string, Suggestion[]> = {}
    for (const s of suggestions) {
      if (!m[s.category]) m[s.category] = []
      m[s.category].push(s)
    }
    return m
  }, [suggestions])

  const manualTags = (byCategory[manualCategory] ?? [])
  const manualFromTag = manualTags.find(t => t.id === manualFrom)
  const manualToTag = manualTags.find(t => t.id === manualTo)

  const openManualConfirm = () => {
    if (manualFromTag && manualToTag && manualFromTag.id !== manualToTag.id) {
      setIntent({ from: manualFromTag, to: manualToTag })
    }
  }

  const confirmMerge = async () => {
    if (!intent) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/trade-tags/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_id: intent.from.id, to_id: intent.to.id }),
      })
      const json = (await res.json()) as MergeResponse
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Merge failed (${res.status})`)
        return
      }
      // Reflect the merge locally so the UI updates without a hard reload:
      // drop the from-tag, move its usage count onto the to-tag.
      const fromKey = `${intent.from.category}|${intent.from.label}`
      const toKey = `${intent.to.category}|${intent.to.label}`
      const fromUsage = usage[fromKey] ?? 0
      const newUsage = { ...usage }
      delete newUsage[fromKey]
      newUsage[toKey] = (newUsage[toKey] ?? 0) + fromUsage
      setUsage(newUsage)
      setTags(tags.filter(t => t.id !== intent.from.id))
      setLastResult(json)
      setIntent(null)
      setManualFrom('')
      setManualTo('')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (t: TradeTag) => {
    if (deleteBusyId) return
    const n = usageFor(t)
    const ok = window.confirm(
      `Remove "${t.label}" from ${labelOf(t.category)}?\n\n` +
      (n > 0
        ? `This deletes it from your library and removes it from ${n} tagged trade${n === 1 ? '' : 's'}. `
        : 'This deletes it from your library. ') +
      'This cannot be undone.',
    )
    if (!ok) return
    setDeleteBusyId(t.id)
    setError(null)
    setDeleteResult(null)
    try {
      const res = await fetch('/api/trade-tags/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id }),
      })
      const json = (await res.json()) as { ok?: boolean; trades_updated?: number; historical_updated?: number; label?: string; error?: string }
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Delete failed (${res.status})`)
        return
      }
      // Local mirror: drop the tag + its usage key so the UI updates instantly.
      setTags(prev => prev.filter(x => x.id !== t.id))
      const next = { ...usage }
      delete next[`${t.category}|${t.label}`]
      setUsage(next)
      setDeleteResult(
        `Removed "${json.label}" — stripped from ${json.trades_updated ?? 0} trades and ${json.historical_updated ?? 0} historical rows.`,
      )
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setDeleteBusyId(null)
    }
  }

  // Create a new tag in a category — reuses the same POST the inline trade-tag
  // picker uses (idempotent server-side: an existing label just comes back).
  const addTag = async (cat: TagCategory) => {
    const label = addDraft.trim()
    if (!label || addBusy) return
    setAddBusy(true)
    setAddError(null)
    try {
      const res = await fetch('/api/trade-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: cat, label }),
      })
      const json = (await res.json()) as { tag?: TradeTag; created?: boolean; error?: string }
      if (!res.ok || !json.tag) { setAddError(json.error ?? `Add failed (${res.status})`); return }
      if (json.created === false) { setAddError(`"${json.tag.label}" already exists in this category.`); return }
      const tag = json.tag
      setTags(prev => (prev.some(t => t.id === tag.id) ? prev : [...prev, tag]))
      setAddDraft('')
      setAddingCat(null)
      router.refresh() // keep the SSR usage tallies in sync
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setAddBusy(false)
    }
  }

  // ── Category management (Pt 16) ───────────────────────────────────────────
  // The category list is the trader's own: they can add an axis, rename the
  // ones they added, and remove any they don't use. Every response carries the
  // freshly-resolved list so local state can never drift from the server's.

  const applyCategories = (next: TagCategoryDef[] | undefined, restoredKey?: string) => {
    if (next) setCats(next)
    if (restoredKey) setHiddenCats(prev => prev.filter(c => c.key !== restoredKey))
    // The trade tagger memoizes this list per page-load; drop the memo so a
    // client-side navigation back to the journal sees the change immediately.
    invalidateTagCategories()
  }

  const createCategory = async () => {
    const label = newCatDraft.trim()
    if (!label || catBusy) return
    setCatBusy('__new__'); setCatError(null); setCatResult(null)
    try {
      const res = await fetch('/api/tag-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      const json = await res.json() as { ok?: boolean; created?: boolean; restored?: boolean; key?: string; categories?: TagCategoryDef[]; error?: string }
      if (!res.ok || !json.ok) { setCatError(json.error ?? `Failed (${res.status})`); return }
      applyCategories(json.categories, json.restored ? json.key : undefined)
      setCatResult(json.restored ? `Brought "${label}" back.` : `Added the "${label}" category.`)
      setNewCatDraft('')
      setNewCatOpen(false)
      router.refresh()
    } catch (e) {
      setCatError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setCatBusy(null)
    }
  }

  const renameCategory = async (key: string) => {
    const label = renameDraft.trim()
    if (!label || catBusy) return
    setCatBusy(key); setCatError(null); setCatResult(null)
    try {
      const res = await fetch('/api/tag-categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label }),
      })
      const json = await res.json() as { ok?: boolean; categories?: TagCategoryDef[]; error?: string }
      if (!res.ok || !json.ok) { setCatError(json.error ?? `Failed (${res.status})`); return }
      applyCategories(json.categories)
      setRenamingCat(null)
      setRenameDraft('')
      router.refresh()
    } catch (e) {
      setCatError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setCatBusy(null)
    }
  }

  const restoreCategory = async (key: string) => {
    if (catBusy) return
    setCatBusy(key); setCatError(null); setCatResult(null)
    try {
      const res = await fetch('/api/tag-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      const json = await res.json() as { ok?: boolean; categories?: TagCategoryDef[]; error?: string }
      if (!res.ok || !json.ok) { setCatError(json.error ?? `Failed (${res.status})`); return }
      applyCategories(json.categories, key)
      setCatResult(`Brought "${labelForCategory(key, [...cats, ...hiddenCats])}" back.`)
      router.refresh()
    } catch (e) {
      setCatError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setCatBusy(null)
    }
  }

  // Removing a category takes its tags with it — leaving them behind would
  // strand labels in tags_json under a heading nothing renders. The count is
  // spelled out before anything is touched.
  const deleteCategory = async (def: TagCategoryDef) => {
    if (catBusy) return
    const catTags = tags.filter(t => t.category === def.key)
    const trades = catTags.reduce((n, t) => n + usageFor(t), 0)
    const ok = window.confirm(
      `Remove the "${def.label}" category?\n\n` +
      (catTags.length > 0
        ? `This also deletes its ${catTags.length} tag${catTags.length === 1 ? '' : 's'}` +
          (trades > 0 ? ` and strips them from ${trades} tagged trade${trades === 1 ? '' : 's'}` : '') + '.\n\n'
        : '') +
      (def.builtin
        ? 'It’s a built-in category, so you can bring it back later — but the tags are gone for good.'
        : 'This cannot be undone.'),
    )
    if (!ok) return

    setCatBusy(def.key); setCatError(null); setCatResult(null)
    try {
      const res = await fetch('/api/tag-categories/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: def.key, delete_tags: true }),
      })
      const json = await res.json() as {
        ok?: boolean; builtin?: boolean; tags_deleted?: number; trades_updated?: number
        historical_updated?: number; categories?: TagCategoryDef[]; error?: string
      }
      if (!res.ok || !json.ok) { setCatError(json.error ?? `Failed (${res.status})`); return }
      applyCategories(json.categories)
      if (json.builtin) setHiddenCats(prev => (prev.some(c => c.key === def.key) ? prev : [...prev, def]))
      setTags(prev => prev.filter(t => t.category !== def.key))
      setUsage(prev => {
        const next = { ...prev }
        for (const k of Object.keys(next)) if (k.startsWith(`${def.key}|`)) delete next[k]
        return next
      })
      setCatResult(
        `Removed "${def.label}" — deleted ${json.tags_deleted ?? 0} tag${json.tags_deleted === 1 ? '' : 's'} ` +
        `and updated ${json.trades_updated ?? 0} trades and ${json.historical_updated ?? 0} historical rows.`,
      )
      router.refresh()
    } catch (e) {
      setCatError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setCatBusy(null)
    }
  }

  return (
    <div className="space-y-8">
      {/* Delete result banner */}
      {deleteResult && (
        <div className="bg-green-900/30 border border-green-800 rounded-lg p-3 text-sm text-green-200 flex items-start gap-2">
          <Trash2 className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{deleteResult}</div>
        </div>
      )}

      {/* Last result banner */}
      {lastResult?.ok && (
        <div className="bg-green-900/30 border border-green-800 rounded-lg p-3 text-sm text-green-200 flex items-start gap-2">
          <GitMerge className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            Merged <span className="font-mono text-green-100">{lastResult.from_label}</span> into{' '}
            <span className="font-mono text-green-100">{lastResult.to_label}</span> —{' '}
            rewrote {lastResult.trades_updated ?? 0} trades and {lastResult.historical_updated ?? 0} historical rows.
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* Category-level result / error banners */}
      {catResult && (
        <div className="bg-green-900/30 border border-green-800 rounded-lg p-3 text-sm text-green-200 flex items-start gap-2">
          <Trash2 className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{catResult}</div>
        </div>
      )}
      {catError && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{catError}</div>
        </div>
      )}

      {/* Per-category sections */}
      {cats.map(def => {
        const cat = def.key
        const catTags = byCategory[cat] ?? []
        // Render EVERY category (even empty ones) so a first tag can be added.
        const catSuggestions = suggestionsByCategory[cat] ?? []
        const renaming = renamingCat === cat
        return (
          <section key={cat} className="space-y-3">
            <div className="flex items-center gap-2 border-b border-gray-800 pb-1">
              {renaming ? (
                <>
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); void renameCategory(cat) }
                      else if (e.key === 'Escape') { setRenamingCat(null); setRenameDraft('') }
                    }}
                    maxLength={40}
                    className="bg-gray-900 border border-gray-600 text-white text-lg font-semibold rounded px-2 py-0.5 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void renameCategory(cat)}
                    disabled={catBusy === cat || !renameDraft.trim()}
                    className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white rounded px-2 py-1"
                  >
                    {catBusy === cat ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setRenamingCat(null); setRenameDraft('') }}
                    className="text-gray-500 hover:text-gray-300"
                    aria-label="Cancel rename"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-white">
                    {def.label}{' '}
                    <span className="text-xs font-normal text-gray-500">({catTags.length})</span>
                  </h2>
                  {!def.builtin && (
                    <span className="text-[10px] uppercase tracking-wider text-blue-400/80 border border-blue-900/60 rounded px-1.5 py-0.5">
                      Yours
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-3">
                    {!def.builtin && (
                      <button
                        type="button"
                        onClick={() => { setRenamingCat(cat); setRenameDraft(def.label); setCatError(null) }}
                        className="text-xs text-gray-600 hover:text-gray-300 transition-colors"
                      >
                        Rename
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void deleteCategory(def)}
                      disabled={catBusy === cat}
                      title={`Remove the "${def.label}" category`}
                      className="text-xs text-gray-600 hover:text-red-400 disabled:opacity-50 transition-colors inline-flex items-center gap-1"
                    >
                      {catBusy === cat ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                      Remove category
                    </button>
                  </div>
                </>
              )}
            </div>

            {catSuggestions.length > 0 && (
              <div className="bg-amber-900/10 border border-amber-900/40 rounded-lg p-3 space-y-2">
                <p className="text-xs uppercase tracking-wider text-amber-300/80">
                  Likely duplicates ({catSuggestions.length})
                </p>
                {catSuggestions.map((s, i) => (
                  <SuggestionRow
                    key={i}
                    suggestion={s}
                    usageA={usageFor(s.a)}
                    usageB={usageFor(s.b)}
                    onMerge={(from, to) => setIntent({ from, to })}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 items-center">
              {catTags.map(t => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1.5 text-xs bg-gray-900 border border-gray-800 rounded-full pl-3 pr-1.5 py-1 text-gray-300"
                  title={`Used by ${usageFor(t)} trade${usageFor(t) === 1 ? '' : 's'}`}
                >
                  <span>{t.label} <span className="text-gray-500">({usageFor(t)})</span></span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(t)}
                    disabled={deleteBusyId === t.id}
                    aria-label={`Remove ${t.label}`}
                    title={`Remove "${t.label}"`}
                    className="text-gray-600 hover:text-red-400 disabled:opacity-50 transition-colors"
                  >
                    {deleteBusyId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                  </button>
                </span>
              ))}

              {/* Inline add — create a new tag in this category. */}
              {addingCat === cat ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    autoFocus
                    value={addDraft}
                    onChange={e => setAddDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); void addTag(cat) }
                      else if (e.key === 'Escape') { setAddingCat(null); setAddDraft(''); setAddError(null) }
                    }}
                    placeholder="New tag…"
                    disabled={addBusy}
                    maxLength={80}
                    className="px-2.5 py-1 rounded-full text-xs bg-gray-900 border border-gray-600 text-gray-100 focus:border-blue-500 focus:outline-none w-40"
                  />
                  <button
                    type="button"
                    onClick={() => void addTag(cat)}
                    disabled={addBusy || !addDraft.trim()}
                    className="px-2.5 py-1 rounded-full text-xs bg-blue-700 border border-blue-600 text-white disabled:opacity-50"
                  >
                    {addBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Add'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAddingCat(null); setAddDraft(''); setAddError(null) }}
                    className="text-gray-600 hover:text-gray-300 px-1"
                    aria-label="Cancel"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => { setAddingCat(cat); setAddDraft(''); setAddError(null) }}
                  className="px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-gray-600 text-gray-500 hover:border-gray-400 hover:text-gray-300 transition-colors"
                >
                  + Add tag
                </button>
              )}
            </div>
            {addingCat === cat && addError && (
              <p className="text-xs text-red-400">{addError}</p>
            )}
          </section>
        )
      })}

      {/* Add your own category + bring back removed built-ins */}
      <section className="border-t border-gray-800 pt-6 space-y-3">
        <h2 className="text-lg font-semibold text-white">Your categories</h2>
        <p className="text-xs text-gray-500">
          Tag along whatever axis you actually think in — a{' '}
          <span className="text-gray-400">4h Candle Shape</span> or{' '}
          <span className="text-gray-400">News Regime</span> category works exactly like the built-in
          ones: it shows up in the trade tagger and breaks out in Patterns.
        </p>

        {newCatOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              autoFocus
              value={newCatDraft}
              onChange={e => setNewCatDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void createCategory() }
                else if (e.key === 'Escape') { setNewCatOpen(false); setNewCatDraft(''); setCatError(null) }
              }}
              placeholder="Category name, e.g. 4h Candle Shape"
              maxLength={40}
              disabled={catBusy === '__new__'}
              className="bg-gray-900 border border-gray-600 text-gray-100 text-sm rounded px-3 py-1.5 w-64 focus:border-blue-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void createCategory()}
              disabled={catBusy === '__new__' || !newCatDraft.trim()}
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs font-medium rounded px-3 py-1.5 transition-colors"
            >
              {catBusy === '__new__' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Add category
            </button>
            <button
              type="button"
              onClick={() => { setNewCatOpen(false); setNewCatDraft(''); setCatError(null) }}
              className="text-xs text-gray-500 hover:text-gray-300 px-1"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setNewCatOpen(true); setNewCatDraft(''); setCatError(null) }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-200 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New category
          </button>
        )}

        {hiddenCats.length > 0 && (
          <div className="pt-2">
            <p className="text-xs text-gray-500 mb-2">Removed categories — bring one back any time:</p>
            <div className="flex flex-wrap gap-2">
              {hiddenCats.map(h => (
                <button
                  key={h.key}
                  type="button"
                  onClick={() => void restoreCategory(h.key)}
                  disabled={catBusy === h.key}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 disabled:opacity-50 transition-colors"
                >
                  {catBusy === h.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Manual merge */}
      <section className="border-t border-gray-800 pt-6 space-y-3">
        <h2 className="text-lg font-semibold text-white">Manual merge</h2>
        <p className="text-xs text-gray-500">
          For pairs the auto-detector misses (e.g. different qualifier wording).
          Merging deletes the &ldquo;from&rdquo; tag and rewrites every trade that uses it.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
          <label className="text-xs text-gray-400 space-y-1">
            Category
            <select
              value={manualCategory}
              onChange={e => { setManualCategory(e.target.value as TagCategory); setManualFrom(''); setManualTo('') }}
              className="w-full bg-gray-900 border border-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              {cats.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-400 space-y-1">
            From (will be deleted)
            <select
              value={manualFrom}
              onChange={e => setManualFrom(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              <option value="">— select —</option>
              {manualTags.map(t => (
                <option key={t.id} value={t.id}>{t.label} ({usageFor(t)})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-400 space-y-1">
            Into (will be kept)
            <select
              value={manualTo}
              onChange={e => setManualTo(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              <option value="">— select —</option>
              {manualTags.filter(t => t.id !== manualFrom).map(t => (
                <option key={t.id} value={t.id}>{t.label} ({usageFor(t)})</option>
              ))}
            </select>
          </label>
          <button
            onClick={openManualConfirm}
            disabled={!manualFromTag || !manualToTag || manualFromTag.id === manualToTag.id}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs font-medium rounded px-3 py-1.5 transition-colors"
          >
            Merge…
          </button>
        </div>
      </section>

      {/* Move tag to another category */}
      <section className="border-t border-gray-800 pt-6 space-y-3">
        <h2 className="text-lg font-semibold text-white">Move tag to another category</h2>
        <p className="text-xs text-gray-500">
          For when a tag is in the wrong category (e.g. &ldquo;Faded LTF Move&rdquo;
          was logged as a Mistake but is really a Confluence). Moves both the
          library row and the data — every trade tagged with it gets the label
          shifted from the old category&apos;s array to the new one&apos;s.
        </p>
        {moveResult && (
          <p className="text-xs text-green-300 bg-green-950/30 border border-green-900/40 rounded px-2 py-1.5">
            {moveResult}
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
          <label className="text-xs text-gray-400 space-y-1">
            From category
            <select
              value={moveSrcCategory}
              onChange={e => { setMoveSrcCategory(e.target.value as TagCategory); setMoveTagId('') }}
              className="w-full bg-gray-900 border border-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              {cats.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-400 space-y-1">
            Tag to move
            <select
              value={moveTagId}
              onChange={e => setMoveTagId(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              <option value="">— select —</option>
              {(byCategory[moveSrcCategory] ?? []).map(t => (
                <option key={t.id} value={t.id}>{t.label} ({usageFor(t)})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-400 space-y-1">
            To category
            <select
              value={moveDstCategory}
              onChange={e => setMoveDstCategory(e.target.value as TagCategory)}
              className="w-full bg-gray-900 border border-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              {cats.filter(c => c.key !== moveSrcCategory).map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <button
            onClick={async () => {
              if (!moveTagId || moveBusy || moveSrcCategory === moveDstCategory) return
              const t = (byCategory[moveSrcCategory] ?? []).find(x => x.id === moveTagId)
              if (!t) return
              if (!confirm(
                `Move "${t.label}" from ${labelOf(moveSrcCategory)} to ${labelOf(moveDstCategory)}?\n\n` +
                `Every trade tagged with "${t.label}" in ${labelOf(moveSrcCategory)} will have that label removed and added to ${labelOf(moveDstCategory)} instead. This cannot be undone except by running the move in reverse.`
              )) return
              setMoveBusy(true)
              setError(null)
              setMoveResult(null)
              try {
                const res = await fetch('/api/trade-tags/recategorize', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tag_id: moveTagId, to_category: moveDstCategory }),
                })
                const json = await res.json() as { ok?: boolean; trades_updated?: number; historical_updated?: number; label?: string; from_category?: TagCategory; to_category?: TagCategory; error?: string }
                if (!res.ok || !json.ok) {
                  setError(json.error ?? `Move failed (${res.status})`)
                  return
                }
                // Local mirror: shift the tag's category, move usage key.
                setTags(prev => prev.map(x => x.id === moveTagId ? { ...x, category: moveDstCategory } : x))
                const oldKey = `${moveSrcCategory}|${t.label}`
                const newKey = `${moveDstCategory}|${t.label}`
                const moved = usage[oldKey] ?? 0
                const next = { ...usage }
                delete next[oldKey]
                next[newKey] = (next[newKey] ?? 0) + moved
                setUsage(next)
                setMoveResult(
                  `Moved "${json.label}" from ${labelOf(json.from_category!)} → ${labelOf(json.to_category!)}. ` +
                  `Rewrote ${json.trades_updated ?? 0} trades and ${json.historical_updated ?? 0} historical rows.`
                )
                setMoveTagId('')
                router.refresh()
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Network error')
              } finally {
                setMoveBusy(false)
              }
            }}
            disabled={!moveTagId || moveBusy || moveSrcCategory === moveDstCategory}
            className="bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs font-medium rounded px-3 py-1.5 transition-colors"
          >
            {moveBusy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </section>

      {/* Confirmation modal */}
      {intent && (
        <ConfirmModal
          intent={intent}
          usageFrom={usageFor(intent.from)}
          usageTo={usageFor(intent.to)}
          busy={busy}
          onCancel={() => { if (!busy) setIntent(null) }}
          onConfirm={confirmMerge}
        />
      )}
    </div>
  )
}

function SuggestionRow({
  suggestion, usageA, usageB, onMerge,
}: {
  suggestion: Suggestion
  usageA: number
  usageB: number
  onMerge: (from: TradeTag, to: TradeTag) => void
}) {
  const { a, b, distance } = suggestion
  return (
    <div className="flex items-center justify-between gap-3 bg-gray-900/60 border border-gray-800 rounded px-3 py-2">
      <div className="text-sm text-gray-200 flex items-center gap-2 min-w-0 flex-1">
        <span className="truncate">
          <span className="text-white">{a.label}</span>
          <span className="text-gray-500 text-xs ml-1">({usageA})</span>
        </span>
        <span className="text-gray-600 text-xs shrink-0">↔ Δ{distance}</span>
        <span className="truncate">
          <span className="text-white">{b.label}</span>
          <span className="text-gray-500 text-xs ml-1">({usageB})</span>
        </span>
      </div>
      <div className="flex gap-1 shrink-0">
        <button
          onClick={() => onMerge(a, b)}
          className="text-[11px] bg-gray-800 hover:bg-gray-700 text-gray-200 rounded px-2 py-1 transition-colors"
          title={`Merge "${a.label}" into "${b.label}"`}
        >
          A→B
        </button>
        <button
          onClick={() => onMerge(b, a)}
          className="text-[11px] bg-gray-800 hover:bg-gray-700 text-gray-200 rounded px-2 py-1 transition-colors"
          title={`Merge "${b.label}" into "${a.label}"`}
        >
          B→A
        </button>
      </div>
    </div>
  )
}

function ConfirmModal({
  intent, usageFrom, usageTo, busy, onCancel, onConfirm,
}: {
  intent: { from: TradeTag; to: TradeTag }
  usageFrom: number
  usageTo: number
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-900 border border-gray-800 rounded-xl max-w-md w-full p-5 space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-semibold text-white">Confirm merge</h3>
          <button onClick={onCancel} disabled={busy} className="text-gray-500 hover:text-gray-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-gray-500 text-xs">From (deleted)</div>
              <div className="text-white truncate">{intent.from.label}</div>
              <div className="text-xs text-gray-500">{usageFrom} usage{usageFrom === 1 ? '' : 's'}</div>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-600 shrink-0" />
            <div className="min-w-0 text-right">
              <div className="text-gray-500 text-xs">Into (kept)</div>
              <div className="text-white truncate">{intent.to.label}</div>
              <div className="text-xs text-gray-500">{usageTo} usage{usageTo === 1 ? '' : 's'}</div>
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-400">
          Every trade tagged with <span className="font-mono">{intent.from.label}</span> will be
          rewritten to use <span className="font-mono">{intent.to.label}</span> instead. The{' '}
          <span className="font-mono">{intent.from.label}</span> tag will be deleted from the library.
          This is not reversible — re-create the tag manually if you change your mind.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 rounded px-3 py-1.5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white rounded px-3 py-1.5 transition-colors flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            Merge
          </button>
        </div>
      </div>
    </div>
  )
}
