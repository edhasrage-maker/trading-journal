'use client'

/**
 * Saving the "Your trade" tag edits (TagEditor). The panel only exists where
 * tags show — Full review, or a replay past your exit — never in Blind.
 *
 * Each change saves at once through PATCH /api/trades/[id] with the WHOLE
 * tags_json: that route writes exactly the fields it is sent, so every key the
 * panel doesn't show (day_type, custom groups, anything unknown) goes back as
 * it was. Saves run one after another. After each, the trade is asked for
 * again, because the Score reads your tags ("no mistakes tagged"). Undo puts
 * back the tags from before the last change.
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ReplayDetails } from '@/app/api/deep-dive/details/route'
import type { TagLibraryRow, TagSaveState } from './TagEditor'
import type { TagEditing } from './YourTrade'

type Details = Record<string, ReplayDetails | { error: string }>
type Tags = Record<string, unknown>

export function useTagEditing(id: string | null, details: Details, setDetails: Dispatch<SetStateAction<Details>>): TagEditing {
  // your tag list, asked for the first time a "+ Add" opens
  const [library, setLibrary] = useState<TagLibraryRow[] | null>(null)
  const asked = useRef(false)
  const onLibrary = useCallback(() => {
    if (asked.current) return
    asked.current = true
    fetch('/api/trade-tags', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : []))
      .then((rows: { category?: unknown; label?: unknown }[]) => setLibrary((Array.isArray(rows) ? rows : [])
        .filter(r => typeof r.category === 'string' && typeof r.label === 'string')
        .map(r => ({ category: r.category as string, label: r.label as string }))))
      .catch(() => { asked.current = false; setLibrary([]) })
  }, [])

  const [last, setLast] = useState<{ id: string; status: TagSaveState; prev: Tags | null } | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)

  const put = useCallback((tid: string, tagsJson: Tags) =>
    setDetails(m => { const d = m[tid]; return d && !('error' in d) ? { ...m, [tid]: { ...d, tagsJson } } : m }), [setDetails])

  const save = useCallback((tid: string, next: Tags, word: string, prev: Tags | null) => {
    put(tid, next)
    setLast({ id: tid, status: { text: 'Saving…', undo: false }, prev })
    pending.current += 1
    chain.current = chain.current.then(async () => {
      try {
        const r = await fetch(`/api/trades/${tid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags_json: next }) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
        const more = pending.current > 1
        setLast(s => (s && s.id === tid && !more ? { ...s, status: { text: `${word} · Saved`, undo: !!prev } } : s))
        const d = await fetch(`/api/deep-dive/details?id=${tid}`, { cache: 'no-store' })
        if (d.ok) {
          const fresh = await d.json() as ReplayDetails
          // another change is still on its way: keep its tags on screen, take the rest (the Score)
          const keep = pending.current > 1
          setDetails(m => {
            const cur = m[tid]
            return { ...m, [tid]: keep && cur && !('error' in cur) ? { ...fresh, tagsJson: cur.tagsJson } : fresh }
          })
        }
      } catch (e) {
        if (prev) put(tid, prev)
        setLast(s => (s && s.id === tid ? { id: tid, prev: null, status: { text: `Couldn’t save: ${e instanceof Error ? e.message : 'network error'}`, undo: false, error: true } } : s))
      }
      pending.current -= 1
    })
  }, [put, setDetails])

  const onCreate = useCallback(async (category: string, label: string): Promise<string> => {
    const r = await fetch('/api/trade-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, label }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j?.tag?.label) throw new Error(j.error ?? `Could not create that tag (HTTP ${r.status})`)
    const made = { category, label: j.tag.label as string }
    setLibrary(l => (!l ? [made] : l.some(x => x.category === made.category && x.label === made.label) ? l : [...l, made]))
    return made.label
  }, [])

  const mine = id ? details[id] : undefined
  const now = mine && !('error' in mine) ? mine.tagsJson : null
  return {
    library, onLibrary, onCreate,
    onChange: (next, word) => { if (id) save(id, next, word, now) },
    status: last && last.id === id ? last.status : null,
    onUndo: () => { if (id && last?.id === id && last.prev) save(id, last.prev, 'Undone', null) },
  }
}
