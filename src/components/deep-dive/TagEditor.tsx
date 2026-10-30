'use client'

/**
 * Your tags, editable in place — the "Your trade" panel (desktop) and tab
 * (phone). Only shown where your tags already are: Full review, or a replay
 * once it reaches your exit; never Blind, where a tag could give the result
 * away.
 *
 * × takes a tag off. "+ Add" opens that group's tags from your own tag list
 * (type to narrow it); a name that isn't there offers Create "…", which adds
 * it to the tag list too (POST /api/trade-tags dedupes case and punctuation,
 * so a near-duplicate comes back as the existing tag). The parent saves each
 * change straight away and offers Undo.
 *
 * Mistake tags one of your rules put on (review_json.auto_tags) are marked
 * "rule". Taking one off works, but the next rule-tags pass puts it back while
 * the rule fails (src/lib/rule-tags.ts), so the panel says so.
 *
 * Tags the coach put on carry a "coach" mark and, until you say, a dashed
 * outline: ✓ keeps one, × takes it off as before (that counts as the coach
 * being wrong — src/lib/coach-tag-audit.ts reads the trade's tags as they
 * are), clicking one shows why the coach picked it, and "All right" keeps
 * every one still to check (founder, 2026-10-29; mockup
 * https://claude.ai/artifact/3zaJp7LnBug1pjs1wwAX23, Deep Dive artboard).
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { tagKey } from '@/lib/tradezella-import'
import { TRADE_TAG_CATS, tagsOf } from '@/lib/trade-tag-groups'
import { useTagCategories } from '@/lib/tag-categories-client'
import type { CoachSource, CoachTagInfo } from '@/lib/coach-tag-audit'

const CONF: Record<string, string> = { H: 'high', M: 'med', L: 'low' }
const FROM: Record<CoachSource, string> = {
  screenshot: 'from your screenshot', notes: 'from your notes', structure: 'from the 5m structure',
  assist: 'when it filled this trade in', before: '',
}

export interface TagLibraryRow { category: string; label: string }
/** What the last change did: "Removed “X” · Saved", "Saving…", or why it didn't save. */
export interface TagSaveState { text: string; undo: boolean; error?: boolean }

export default function TagEditor({
  tags, ruleTags, tradeId, coach = {}, library, onLibrary, onChange, onCreate, status, onUndo, big,
}: {
  /** The trade's whole tags_json. */
  tags: Record<string, unknown>
  /** App-added mistake tags → the rule that put each on. */
  ruleTags: Record<string, string>
  /** The trade, for ✓ on the coach's tags. */
  tradeId?: string
  /** The coach's tags on it, `category|label` → how sure, why, already kept. */
  coach?: Record<string, CoachTagInfo>
  /** Your tag list; null until asked for. */
  library: TagLibraryRow[] | null
  onLibrary: () => void
  /** Save the trade's whole tags_json; `word` says what changed. */
  onChange: (next: Record<string, unknown>, word: string) => void
  /** Add a tag to your tag list; resolves to the label as stored. */
  onCreate: (category: string, label: string) => Promise<string>
  status: TagSaveState | null
  onUndo: () => void
  /** Phone tab: bigger targets. */
  big: boolean
}) {
  // the built-in groups you kept (Settings → Tags), plus any hidden one this trade still has tags in
  const cats = useTagCategories()
  const groups = TRADE_TAG_CATS.filter(c => cats.some(k => k.key === c.key) || tagsOf(tags, c.key).length > 0)
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [note, setNote] = useState<{ key: string; rule: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // ✓ given here this visit (the server's `kept` covers earlier ones), and which coach tag shows its reason
  const [keptNow, setKeptNow] = useState<Set<string>>(new Set())
  const [why, setWhy] = useState<string | null>(null)
  const [coachErr, setCoachErr] = useState<string | null>(null)
  const coachKey = (cat: string, label: string) => `${cat}|${label}`
  const isCoach = (cat: string, label: string) => coachKey(cat, label) in coach && !(cat === 'mistakes' && label in ruleTags)
  const pending = (cat: string, label: string) => isCoach(cat, label) && !coach[coachKey(cat, label)].kept && !keptNow.has(coachKey(cat, label))
  const pendingKeys = groups.flatMap(c => tagsOf(tags, c.key).filter(t => pending(c.key, t)).map(t => coachKey(c.key, t)))
  const anyCoach = groups.some(c => tagsOf(tags, c.key).some(t => isCoach(c.key, t)))
  const keep = async (keys: string[]) => {
    if (!tradeId || !keys.length) return
    setCoachErr(null)
    setKeptNow(k => new Set([...k, ...keys]))
    try {
      const res = await fetch('/api/coach-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'keep', tradeId, keys }) })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not save that.')
    } catch (e) {
      setKeptNow(k => { const n = new Set(k); keys.forEach(x => n.delete(x)); return n })
      setCoachErr(e instanceof Error ? e.message : 'Could not save that.')
    }
  }

  // a click outside the open group closes its list
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(null) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  const toggle = (key: string) => {
    setOpen(o => (o === key ? null : key)); setQuery(''); setErr(null)
    onLibrary()
  }
  const remove = (key: string, label: string) => {
    onChange({ ...tags, [key]: tagsOf(tags, key).filter(t => t !== label) }, `Removed “${label}”`)
    setNote(key === 'mistakes' && label in ruleTags ? { key, rule: ruleTags[label] } : null)
  }
  const add = (key: string, label: string, word = `Added “${label}”`) => {
    const on = tagsOf(tags, key)
    setOpen(null); setQuery(''); setNote(null)
    if (on.some(t => tagKey(t) === tagKey(label))) return
    onChange({ ...tags, [key]: [...on, label] }, word)
  }
  const create = async (key: string, name: string) => {
    setBusy(true); setErr(null)
    try {
      const label = await onCreate(key, name)
      add(key, label, `Created and added “${label}”`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create that tag')
    } finally {
      setBusy(false)
    }
  }

  const cap = cn('font-semibold uppercase tracking-[.8px] text-gray-400', big ? 'text-[11px]' : 'text-[10.5px]')
  const indent = big ? '' : 'ml-[82px]'
  return (
    <div>
      <div className={cn('flex items-baseline justify-between mt-4 mb-1')}>
        <span className={cap}>Your tags</span>
        {status ? (
          <span className={cn(big ? 'text-[12.5px]' : 'text-[11.5px]', status.error ? 'text-red-400' : 'text-gray-400')} role="status">
            {status.text}
            {status.undo && <> · <button type="button" onClick={onUndo} className={cn('text-blue-400 hover:underline', big && 'py-2')}>Undo</button></>}
          </span>
        ) : anyCoach && (
          <span className={cn(big ? 'text-[12.5px]' : 'text-[11.5px]', 'text-gray-300')}>
            {pendingKeys.length
              ? <>{pendingKeys.length} coach tag{pendingKeys.length === 1 ? '' : 's'} to check · <button type="button" onClick={() => void keep(pendingKeys)} className={cn('text-blue-400 hover:underline', big && 'py-2')}>All right</button></>
              : 'Coach tags checked'}
          </span>
        )}
      </div>
      {coachErr && <p className={cn('text-red-400', big ? 'text-[12.5px]' : 'text-[11.5px]')} role="alert">{coachErr}</p>}
      {groups.map(c => {
        const on = tagsOf(tags, c.key)
        const isOpen = open === c.key
        const q = query.trim()
        const fromList = (library ?? []).filter(r => r.category === c.key)
        const free = fromList.filter(r => !on.some(t => tagKey(t) === tagKey(r.label)))
        const shown = free.filter(r => !q || tagKey(r.label).includes(tagKey(q)))
        const known = !!q && (fromList.some(r => tagKey(r.label) === tagKey(q)) || on.some(t => tagKey(t) === tagKey(q)))
        const pick = () => { if (shown[0]) add(c.key, shown[0].label); else if (q && !known && !busy) void create(c.key, q) }
        return (
          <div key={c.key} ref={isOpen ? boxRef : undefined} className={cn('border-b border-gray-800', big ? 'py-[7px] text-[13px]' : 'py-1.5 text-[12px]')}>
            <div className="flex gap-2">
              <span className={cn('flex-none text-gray-400', big ? 'w-[82px] pt-[7px]' : 'w-[74px] pt-[3px]')}>{c.label}</span>
              <span className={cn('flex flex-wrap min-w-0', big ? 'gap-1.5' : 'gap-1')}>
                {on.map(t => {
                  const rule = c.key === 'mistakes' && t in ruleTags
                  const byCoach = isCoach(c.key, t)
                  const toCheck = pending(c.key, t)
                  const info = byCoach ? coach[coachKey(c.key, t)] : null
                  const k = coachKey(c.key, t)
                  return (
                    <span key={t} className={cn(
                      'inline-flex items-center rounded-full border',
                      big ? 'h-8 pl-2.5 pr-0.5 gap-0.5 text-[12.5px]' : 'py-0.5 pl-2 pr-1.5 gap-[3px] text-[11.5px]',
                      toCheck ? 'border-dashed border-blue-500 bg-blue-950 text-gray-100'
                        : c.danger ? 'border-red-800/60 text-red-300 bg-red-950/30' : 'border-gray-700 text-gray-100',
                    )}>
                      {byCoach ? (
                        <button type="button" onClick={() => setWhy(w => (w === k ? null : k))} aria-expanded={why === k} className="inline-flex items-center">
                          {t}
                          <span className={cn('px-1 rounded-[3px] bg-blue-500/20 text-blue-200 font-semibold tracking-[.3px]', big ? 'ml-[3px] text-[10px]' : 'ml-1 text-[9.5px]')}>
                            coach{info?.conf ? ` · ${CONF[info.conf]}` : ''}
                          </span>
                        </button>
                      ) : t}
                      {toCheck && (
                        <button type="button" onClick={() => void keep([k])} aria-label={`Keep ${t}`}
                          className={cn('rounded-full bg-blue-300/15 text-blue-300 inline-flex items-center justify-center hover:bg-blue-300/25', big ? 'w-[30px] h-[30px]' : 'w-5 h-5 ml-0.5')}>
                          <svg width={big ? 13 : 11} height={big ? 13 : 11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
                        </button>
                      )}
                      {byCoach && !toCheck && (
                        <span className="text-blue-300 inline-flex px-0.5" aria-label="kept">
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
                        </span>
                      )}
                      {rule && (
                        <span title={ruleTags[t] ? `Added by your rule ${ruleTags[t]}` : 'Added by one of your rules'}
                          className={cn('px-1 rounded-[3px] bg-red-500/15 text-red-300 font-semibold tracking-[.3px]', big ? 'ml-[3px] text-[10px]' : 'text-[9.5px]')}>rule</span>
                      )}
                      <button type="button" onClick={() => remove(c.key, t)} aria-label={`Remove ${t}`}
                        className={cn('leading-none text-gray-400 hover:text-gray-100', big ? 'w-[30px] h-[30px] text-[16px]' : 'pl-0.5 text-[13px]')}>×</button>
                    </span>
                  )
                })}
                <button type="button" onClick={() => toggle(c.key)} aria-expanded={isOpen}
                  className={cn('rounded-full border border-dashed border-gray-600 text-blue-400 hover:border-blue-500', big ? 'h-8 px-3 text-[12.5px]' : 'px-2 py-px text-[11.5px]')}>+ Add</button>
              </span>
            </div>

            {isOpen && (
              <div className={cn('mt-1.5 mb-0.5 border border-gray-700 overflow-hidden shadow-lg', big ? 'rounded-lg mt-2' : 'rounded-md', indent)}
                style={{ background: 'var(--color-surface-1)' }}>
                <input
                  type="text" autoFocus value={query} aria-label={`Find or create a ${c.label} tag`} placeholder="Type to find a tag"
                  onChange={e => { setQuery(e.target.value); setErr(null) }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { e.preventDefault(); setOpen(null) }
                    else if (e.key === 'Enter') { e.preventDefault(); pick() }
                  }}
                  className={cn('block w-full bg-transparent border-b border-gray-800 text-gray-100 placeholder-gray-500 focus:outline-none', big ? 'h-11 px-2.5 text-[16px]' : 'px-2 py-1.5 text-[12.5px]')}
                />
                <div className={cn(!big && 'max-h-[170px] overflow-y-auto')}>
                  {!library && <p className={cn('text-gray-400', big ? 'px-2.5 py-3 text-[13px]' : 'px-2 py-1.5 text-[12px]')}>Loading your tags…</p>}
                  {shown.map(r => (
                    <button key={r.label} type="button" onClick={() => add(c.key, r.label)}
                      className={cn('block w-full text-left text-gray-100 hover:bg-gray-800/60', big ? 'h-11 px-2.5 text-[14px] border-b border-gray-800/60' : 'px-2 py-[5px] text-[12.5px]')}>{r.label}</button>
                  ))}
                  {q && !known && (
                    <button type="button" disabled={busy} onClick={() => void create(c.key, q)}
                      className={cn('block w-full text-left text-blue-400 hover:bg-gray-800/60 disabled:opacity-50', big ? 'h-11 px-2.5 text-[14px]' : 'px-2 py-[5px] text-[12.5px] border-t border-gray-800/60')}>
                      {busy ? 'Creating…' : `Create “${q}”`}
                    </button>
                  )}
                  {library && !q && free.length === 0 && (
                    <p className={cn('text-gray-400', big ? 'px-2.5 py-3 text-[13px]' : 'px-2 py-1.5 text-[12px]')}>
                      {fromList.length ? `All your ${c.label} tags are on this trade.` : 'Type a name to create one.'}
                    </p>
                  )}
                  {err && <p className={cn('text-red-400', big ? 'px-2.5 py-2 text-[13px]' : 'px-2 py-1.5 text-[12px]')}>{err}</p>}
                </div>
              </div>
            )}

            {why && why.startsWith(`${c.key}|`) && on.some(t => coachKey(c.key, t) === why) && (
              <p className={cn('mt-1.5 leading-snug text-gray-200', big ? 'text-[12.5px]' : 'text-[11.5px]', indent)}>
                <span className="text-gray-400">The coach{coach[why].conf ? ` (${CONF[coach[why].conf!]})` : ''} on {why.slice(c.key.length + 1)}:</span>{' '}
                {coach[why].reason ?? `picked it ${FROM[coach[why].source]}.`}
              </p>
            )}
            {note?.key === c.key && (
              <p className={cn('mt-1.5 leading-snug text-red-300', big ? 'text-[12.5px]' : 'text-[11.5px]', indent)}>
                Added by {note.rule ? `your rule ${note.rule}` : 'one of your rules'}; it comes back while the rule fails. Change the rule in Settings → Trading Rules.
              </p>
            )}
          </div>
        )
      })}
      {anyCoach && (
        <p className={cn('mt-3 leading-relaxed text-gray-400', big ? 'text-[12.5px]' : 'text-[11.5px]')}>
          <span className="px-1 rounded-[3px] bg-blue-500/20 text-blue-200 font-semibold text-[9.5px]">coach</span>{' '}
          = the coach put it on. ✓ keeps it, × takes it off and counts as the coach being wrong. Click a tag to see why.
        </p>
      )}
    </div>
  )
}
