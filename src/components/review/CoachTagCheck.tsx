'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUiMode } from '@/lib/ui-mode'
import type { CoachSource, Outcome } from '@/lib/coach-tag-audit'

/**
 * Weekly review → "Check the coach's tags" (founder, 2026-10-28; mockup
 * https://claude.ai/artifact/3zaJp7LnBug1pjs1wwAX23, Main artboard).
 *
 * Every trade this week the coach picked tags on, with its tags in groups.
 * The coach's tags carry ✓ (keep) and ✕ (take it off the trade); "All right"
 * keeps every one still to check on that trade. Clicking a tag shows why the
 * coach picked it. Your own tags, your rules' tags and day types are shown
 * plain — nothing to check. Under the list, one line: how often the coach is
 * right over all weeks, linking to the full table in Settings → Tags.
 *
 * In Highlights the section starts minimized to one line (counts + Show);
 * in Detailed Tape it starts open (founder, 2026-10-29; mockup artboard
 * "Weekly review in Highlights").
 *
 * The server builds every row (src/lib/coach-tag-audit-server.ts); this only
 * shows them and sends ✓ / ✕ / Undo to /api/coach-tags.
 */

export interface CoachCheckChip {
  /** `category|label` — what /api/coach-tags takes. */
  key: string
  label: string
  kind: 'coach' | 'you'
  /** Coach tags only. */
  outcome?: Outcome
  conf?: 'H' | 'M' | 'L' | null
  reason?: string | null
  source?: CoachSource
}

export interface CoachCheckTrade {
  id: string
  day: string
  time: string
  dir: string
  pnl: number | null
  href: string
  groups: Array<{ name: string; chips: CoachCheckChip[] }>
}

export interface CoachCheckData {
  trades: CoachCheckTrade[]
  /** Kept / taken off on every OTHER week, so the line can add this week's live. */
  otherKept: number
  otherRemoved: number
}

const CONF: Record<string, string> = { H: 'high', M: 'med', L: 'low' }
const FROM: Record<CoachSource, string> = {
  screenshot: 'from your screenshot', notes: 'from your notes', structure: 'from the 5m structure',
  assist: 'when it filled this trade in', before: '',
}
const fmtUsd = (v: number) => `${v < 0 ? '-' : '+'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`

export default function CoachTagCheck({ data }: { data: CoachCheckData }) {
  // tradeId::key → outcome, overriding what the server sent
  const [over, setOver] = useState<Record<string, Outcome>>({})
  const [why, setWhy] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)
  const { mode } = useUiMode()
  const highlights = mode === 'beginner'
  // the trader's own Show / Hide wins; until then Highlights starts minimized
  const [openPick, setOpenPick] = useState<boolean | null>(null)
  const open = openPick ?? !highlights

  const outcomeOf = (t: CoachCheckTrade, c: CoachCheckChip): Outcome => over[`${t.id}::${c.key}`] ?? c.outcome ?? 'pending'

  let waiting = 0, kept = 0, removed = 0
  for (const t of data.trades) for (const g of t.groups) for (const c of g.chips) {
    if (c.kind !== 'coach') continue
    const o = outcomeOf(t, c)
    if (o === 'kept') kept++; else if (o === 'removed') removed++; else waiting++
  }
  const allKept = data.otherKept + kept, allRemoved = data.otherRemoved + removed
  const checked = allKept + allRemoved

  const send = async (t: CoachCheckTrade, action: 'keep' | 'remove' | 'undo', keys: string[], next: Outcome) => {
    const ids = keys.map(k => `${t.id}::${k}`)
    if (ids.some(id => busy.has(id))) return
    const prev = Object.fromEntries(ids.map(id => [id, over[id]]))
    setErr(null)
    setOver(o => ({ ...o, ...Object.fromEntries(ids.map(id => [id, next])) }))
    setBusy(b => new Set([...b, ...ids]))
    try {
      const body = action === 'keep' ? { action, tradeId: t.id, keys } : { action, tradeId: t.id, key: keys[0] }
      const res = await fetch('/api/coach-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not save that.')
    } catch (e) {
      setOver(o => {
        const n = { ...o }
        for (const id of ids) { if (prev[id] === undefined) delete n[id]; else n[id] = prev[id] }
        return n
      })
      setErr(e instanceof Error ? e.message : 'Could not save that.')
    } finally {
      setBusy(b => { const n = new Set(b); ids.forEach(id => n.delete(id)); return n })
    }
  }

  return (
    <div className="mt-8 pt-4 border-t border-gray-800">
      {highlights ? (
        <button type="button" onClick={() => setOpenPick(!open)} aria-expanded={open}
          className={cn('w-full flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-1.5 text-left', open && 'mb-2')}>
          <span className="inline-flex items-center gap-2">
            <ChevronRight size={14} aria-hidden="true" className={cn('text-gray-400 transition-transform self-center', open && 'rotate-90')} />
            <span className="text-[15px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Check the coach&apos;s tags</span>
          </span>
          <span className="text-[13px] text-gray-300 tabular-nums">
            <b className="text-gray-100 font-semibold">{waiting}</b> to check · <b className="text-blue-300 font-semibold">{kept}</b> kept · <b className="text-[#E8A15A] font-semibold">{removed}</b> taken off
            <span className="ml-3.5 text-blue-300">{open ? 'Hide' : 'Show'}</span>
          </span>
        </button>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 mb-2">
          <span className="text-[15px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Check the coach&apos;s tags</span>
          <span className="text-[13px] text-gray-300 tabular-nums">
            <b className="text-gray-100 font-semibold">{waiting}</b> to check · <b className="text-blue-300 font-semibold">{kept}</b> kept · <b className="text-[#E8A15A] font-semibold">{removed}</b> taken off
          </span>
        </div>
      )}
      {open && <>
      <p className="text-[13.5px] leading-relaxed text-gray-300 max-w-[820px] mb-3">
        ✓ keeps a tag, ✕ takes it off the trade. Click a tag to see why the coach picked it. Taking a tag off or adding one anywhere else (the trade form, Deep Dive) counts too.
      </p>
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[12px] text-gray-400 mb-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="border border-dashed border-blue-500 bg-blue-950 text-blue-200 rounded-full px-2.5 py-1 text-[11.5px]">Setup</span>the coach&apos;s pick
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="border border-gray-700 bg-gray-800 text-gray-300 rounded-full px-2.5 py-1 text-[11.5px]">Tag</span>yours or your rules&apos;, nothing to check
        </span>
      </div>
      {err && <p className="text-[12.5px] text-red-400 mb-2" role="alert">{err}</p>}

      {data.trades.map(t => {
        const pend = t.groups.flatMap(g => g.chips).filter(c => c.kind === 'coach' && outcomeOf(t, c) === 'pending').map(c => c.key)
        const whyChip = why?.startsWith(`${t.id}::`) ? t.groups.flatMap(g => g.chips).find(c => `${t.id}::${c.key}` === why) : null
        return (
          <div key={t.id} className="border-t border-gray-800 py-4 flex flex-wrap items-start gap-x-[22px] gap-y-3">
            <div className="flex-[0_0_116px] flex flex-col gap-0.5">
              <span className="text-[12px] text-gray-400">{t.day}</span>
              <span className="text-[15px] text-gray-100" style={{ fontFamily: 'var(--font-mono)' }}>{t.time}</span>
              <span className="text-[13px] text-gray-300">
                {t.dir}{t.pnl != null && <> · <span className={t.pnl < 0 ? 'text-red-400' : 'text-green-400'}>{fmtUsd(t.pnl)}</span></>}
              </span>
            </div>
            <div className="flex-[999_1_460px] min-w-0 flex flex-wrap items-center gap-x-4 gap-y-2.5">
              {t.groups.map(g => (
                <div key={g.name} className="inline-flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] uppercase tracking-[0.06em] text-gray-400 font-semibold">{g.name}</span>
                  {g.chips.map(c => {
                    if (c.kind === 'you') {
                      return <span key={c.key} className="border border-gray-700 bg-gray-800 text-gray-300 rounded-full px-[11px] py-[7px] text-[12.5px] leading-none">{c.label}</span>
                    }
                    const o = outcomeOf(t, c)
                    const id = `${t.id}::${c.key}`
                    return (
                      <span key={c.key} className={cn(
                        'inline-flex items-center gap-0.5 rounded-full text-[12.5px] leading-none pr-[3px]',
                        o === 'kept' ? 'border border-blue-600 bg-blue-800 text-gray-100'
                          : o === 'removed' ? 'border border-gray-700 text-gray-400'
                            : 'border border-dashed border-blue-500 bg-blue-950 text-blue-200',
                      )}>
                        <button type="button" onClick={() => setWhy(why === id ? null : id)}
                          className={cn('rounded-full pl-[11px] pr-1.5 py-[7px]', o === 'removed' && 'line-through')}>
                          {c.label}
                          {c.conf && <span className="ml-1.5 text-[10px] tracking-[0.04em] opacity-85">{CONF[c.conf]}</span>}
                        </button>
                        {o === 'pending' ? (
                          <>
                            <button type="button" aria-label={`Keep ${c.label}`} onClick={() => send(t, 'keep', [c.key], 'kept')}
                              className="w-7 h-7 rounded-full bg-blue-300/10 text-blue-300 inline-flex items-center justify-center hover:bg-blue-300/20">
                              <Check size={14} strokeWidth={2.25} aria-hidden="true" />
                            </button>
                            <button type="button" aria-label={`Take off ${c.label}`} onClick={() => send(t, 'remove', [c.key], 'removed')}
                              className="w-7 h-7 rounded-full bg-[#E8A15A]/10 text-[#E8A15A] inline-flex items-center justify-center hover:bg-[#E8A15A]/20">
                              <X size={12} strokeWidth={2.25} aria-hidden="true" />
                            </button>
                          </>
                        ) : (
                          <button type="button" onClick={() => send(t, 'undo', [c.key], 'pending')}
                            className="text-[11px] text-gray-400 underline px-2 py-1.5 pl-0.5">Undo</button>
                        )}
                      </span>
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="flex-[1_0_140px] flex flex-col items-end gap-2">
              {pend.length > 0 ? (
                <button type="button" onClick={() => send(t, 'keep', pend, 'kept')}
                  className="border border-blue-600 text-blue-300 rounded-md px-3.5 py-2 text-[13px] font-semibold min-h-[38px] hover:bg-blue-950">
                  All right · {pend.length}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 py-2"><Check size={14} aria-hidden="true" />Checked</span>
              )}
              <Link href={t.href} className="text-[13px] text-blue-300 hover:text-blue-200">Open trade</Link>
            </div>
            {whyChip && (
              <div className="basis-full sm:ml-[138px] text-[13px] leading-relaxed text-gray-200 bg-gray-900 border border-gray-800 rounded-md px-3 py-2">
                <span className="text-gray-400">The coach{whyChip.conf ? ` (${CONF[whyChip.conf]})` : ''} on {whyChip.label}:</span>{' '}
                {whyChip.reason ?? `picked it ${FROM[whyChip.source ?? 'notes']}.`}
              </div>
            )}
          </div>
        )
      })}

      <div className="border-t border-gray-800 pt-4 flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 text-[13.5px] text-gray-300">
        <span>
          The coach&apos;s tags:{' '}
          {checked
            ? <><b className="text-gray-100 font-semibold">{Math.round(allKept / checked * 100)}% right</b> over {checked} checked, all weeks</>
            : <><b className="text-gray-100 font-semibold">nothing checked yet</b> — check a few above and this fills in</>}
        </span>
        <Link href="/settings/tags#coach-accuracy" className="text-[13px] text-blue-300 hover:text-blue-200">See every tag in Settings</Link>
      </div>
      </>}
    </div>
  )
}
