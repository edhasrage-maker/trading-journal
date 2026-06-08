'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, ArrowRight, Loader2, GitMerge, X } from 'lucide-react'
import type { TagCategory, TradeTag } from '@/lib/supabase/types'

interface Props {
  tags: TradeTag[]
  /** Keyed by `${category}|${label}`; missing keys = 0. */
  usage: Record<string, number>
}

const CATEGORY_ORDER: TagCategory[] = [
  'setups', 'confluences', 'order_flow', 'trade_management', 'day_type', 'mistakes', 'emotions',
]

const CATEGORY_LABELS: Record<TagCategory, string> = {
  setups: 'Setups',
  confluences: 'Confluences',
  order_flow: 'Order Flow',
  entry_model: 'Entry Model',
  trade_management: 'Trade Management',
  day_type: 'Day Type',
  mistakes: 'Mistakes',
  emotions: 'Emotions',
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

export default function TagMergeClient({ tags: initialTags, usage: initialUsage }: Props) {
  const router = useRouter()
  const [tags, setTags] = useState(initialTags)
  const [usage, setUsage] = useState(initialUsage)
  const [intent, setIntent] = useState<MergeIntent>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<MergeResponse | null>(null)
  const [manualCategory, setManualCategory] = useState<TagCategory>('setups')
  const [manualFrom, setManualFrom] = useState<string>('')
  const [manualTo, setManualTo] = useState<string>('')
  // Move-tag state: pick a source category, pick a tag from it, pick the
  // destination category. Independent of the merge state above.
  const [moveSrcCategory, setMoveSrcCategory] = useState<TagCategory>('mistakes')
  const [moveTagId, setMoveTagId] = useState<string>('')
  const [moveDstCategory, setMoveDstCategory] = useState<TagCategory>('confluences')
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveResult, setMoveResult] = useState<string | null>(null)

  const suggestions = useMemo(() => suggestPairs(tags, 2), [tags])

  const usageFor = (t: TradeTag): number => usage[`${t.category}|${t.label}`] ?? 0

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

  return (
    <div className="space-y-8">
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

      {/* Per-category sections */}
      {CATEGORY_ORDER.map(cat => {
        const catTags = byCategory[cat] ?? []
        if (catTags.length === 0) return null
        const catSuggestions = suggestionsByCategory[cat] ?? []
        return (
          <section key={cat} className="space-y-3">
            <h2 className="text-lg font-semibold text-white border-b border-gray-800 pb-1">
              {CATEGORY_LABELS[cat]}{' '}
              <span className="text-xs font-normal text-gray-500">({catTags.length})</span>
            </h2>

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

            <div className="flex flex-wrap gap-2">
              {catTags.map(t => (
                <span
                  key={t.id}
                  className="text-xs bg-gray-900 border border-gray-800 rounded-full px-3 py-1 text-gray-300"
                  title={`Used by ${usageFor(t)} trade${usageFor(t) === 1 ? '' : 's'}`}
                >
                  {t.label}{' '}
                  <span className="text-gray-500">({usageFor(t)})</span>
                </span>
              ))}
            </div>
          </section>
        )
      })}

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
              {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
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
              {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
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
              {CATEGORY_ORDER.filter(c => c !== moveSrcCategory).map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <button
            onClick={async () => {
              if (!moveTagId || moveBusy || moveSrcCategory === moveDstCategory) return
              const t = (byCategory[moveSrcCategory] ?? []).find(x => x.id === moveTagId)
              if (!t) return
              if (!confirm(
                `Move "${t.label}" from ${CATEGORY_LABELS[moveSrcCategory]} to ${CATEGORY_LABELS[moveDstCategory]}?\n\n` +
                `Every trade tagged with "${t.label}" in ${CATEGORY_LABELS[moveSrcCategory]} will have that label removed and added to ${CATEGORY_LABELS[moveDstCategory]} instead. This cannot be undone except by running the move in reverse.`
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
                  `Moved "${json.label}" from ${CATEGORY_LABELS[json.from_category!]} → ${CATEGORY_LABELS[json.to_category!]}. ` +
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
