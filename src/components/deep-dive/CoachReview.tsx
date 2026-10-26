'use client'

/**
 * Coach Review — Claude's read of the trade at the fill (founder-approved
 * mockup, Design canvas row "Coach Review"). It opens only after your call is
 * saved, so your read stays your own: "Save my call and ask" saves the call
 * bar's pick (the same save) and asks in one click. In Blind it opens for a
 * call made on this visit; elsewhere for any saved call. It reads only the
 * Blind cut (src/lib/coach-review.ts) in every mode, so Full review shows the
 * same saved read. Saved on the trade: opening it again uses nothing.
 *
 * For / Against / Look at carry no green or red: those read as a result.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/components/ThemeToggle'
import type { TradeCoachReview, TradeVerdict } from '@/lib/supabase/types'
import type { CoachReviewResponse, CoachReviewUsage } from '@/app/api/deep-dive/coach-review/route'

type Call = TradeVerdict['call']
const CALL_WORD: Record<Call, { label: string; cls: string }> = {
  good: { label: 'Good', cls: 'text-green-400' },
  mistake: { label: 'Mistake', cls: 'text-red-400' },
  unsure: { label: 'Unsure', cls: 'text-gray-300' },
}
const GROUPS: { kind: 'for' | 'against' | 'look'; label: string; mark: string }[] = [
  { kind: 'for', label: 'For', mark: '+' },
  { kind: 'against', label: 'Against', mark: '−' },
  { kind: 'look', label: 'Look at', mark: '→' },
]

const LockIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
)

const asked = (iso: string) => {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const today = d.toDateString() === new Date().toDateString()
  return today
    ? `today ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function CoachReview({ tradeId, unlocked, full, draft, myCall, onSaveCall, orderFlow, big = false }: {
  tradeId: string
  /** Your call is saved: in Blind, made on this visit; otherwise any saved call. */
  unlocked: boolean
  /** Full review, or a replay past your exit: it says it still reads only the fill. */
  full: boolean
  /** The call bar's pick, not saved yet. */
  draft: { call: Call | null; note: string } | null
  /** Your saved call, shown above the read. */
  myCall: { call: Call; note: string } | null
  /** Saves the call bar's pick (the call bar's own save); true when it saved. */
  onSaveCall: () => Promise<boolean>
  /** Your profile uses order flow (the "What it reads" words). */
  orderFlow: boolean
  /** Phone tab: bigger text and targets. */
  big?: boolean
}) {
  const theme = useTheme()
  const [usage, setUsage] = useState<CoachReviewUsage | null>(null)
  const [data, setData] = useState<{ review: TradeCoachReview | null; stale: string | null; tooOld: boolean } | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'asking' | 'error'>('idle')
  const [err, setErr] = useState<string | null>(null)
  // while asking, a GET that lands late must not put back an older answer
  const asking = useRef(false)

  useEffect(() => {
    let live = true
    fetch(`/api/deep-dive/coach-review?id=${tradeId}${unlocked ? '&open=1' : ''}`, { cache: 'no-store' })
      .then(async r => {
        const j = await r.json().catch(() => ({})) as CoachReviewResponse
        if (!live) return
        if (j.usage) setUsage(j.usage)
        if (unlocked && !asking.current) setData(r.ok ? { review: j.review ?? null, stale: j.stale ?? null, tooOld: !!j.tooOld } : { review: null, stale: null, tooOld: false })
      })
      .catch(() => { /* the panel shows no count */ })
    return () => { live = false }
  }, [tradeId, unlocked])

  const ask = async () => {
    asking.current = true
    setPhase('asking'); setErr(null)
    try {
      const r = await fetch('/api/deep-dive/coach-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tradeId }) })
      const j = await r.json().catch(() => ({})) as CoachReviewResponse
      if (j.usage) setUsage(j.usage)
      if (r.ok && j.review) { setData({ review: j.review, stale: j.stale ?? null, tooOld: false }); setPhase('idle') }
      else if (r.status === 429) { setData(d => d ?? { review: null, stale: null, tooOld: false }); setPhase('idle') }
      else if (j.tooOld) { setData({ review: null, stale: null, tooOld: true }); setPhase('idle') }
      else { setErr(j.error ?? `HTTP ${r.status}`); setPhase('error') }
    } catch {
      setErr('Couldn\'t get one just now.'); setPhase('error')
    } finally {
      asking.current = false
    }
  }
  const saveAndAsk = async () => {
    if (!draft?.call) return
    setPhase('saving'); setErr(null)
    const ok = await onSaveCall().catch(() => false)
    if (!ok) { setErr('Your call didn\'t save. Try again.'); setPhase('error'); return }
    await ask()
  }
  const saveOnly = async () => {
    if (!draft?.call) return
    const ok = await onSaveCall().catch(() => false)
    if (!ok) { setErr('Your call didn\'t save. Try again.'); setPhase('error') }
  }

  const t = big ? 'text-[13.5px]' : 'text-[12.5px]'
  const small = big ? 'text-[12.5px]' : 'text-[11.5px]'
  const cap = cn('font-semibold uppercase tracking-[.8px] text-gray-400 mt-3.5 mb-1.5', big ? 'text-[11px]' : 'text-[10.5px]')
  const box = cn('mt-3 border border-gray-800 rounded-md', big ? 'p-3.5' : 'p-3')
  const boxStyle = { background: 'var(--color-surface-2)' }
  const primary = cn('block w-full rounded bg-blue-500 text-white font-semibold disabled:opacity-50', big ? 'h-11 text-[14px]' : 'py-2 text-[12.5px]')
  const secondary = cn('block w-full rounded border border-gray-800 text-gray-100 font-semibold', big ? 'h-11 text-[14px]' : 'py-[7px] text-[12.5px]')
  const left = usage ? `${usage.remaining} of ${usage.limit} left today` : ''
  const none = !!usage && usage.remaining <= 0
  const review = unlocked ? data?.review ?? null : null
  const busy = phase === 'saving' || phase === 'asking'
  const sub = busy || review || (unlocked && !none) ? 'from the fill' : none ? 'none left today' : 'opens after your call'
  const caution = theme === 'light' ? { background: '#FFF1DC', color: '#6B4100' } : { background: 'rgba(255,159,26,.14)', color: '#FFC266' }

  const echo = myCall && (
    <div className={cn(box, t)} style={boxStyle}>
      Your call <b className={cn('font-semibold', CALL_WORD[myCall.call].cls)}>{CALL_WORD[myCall.call].label}</b>
      {myCall.note && <span className="text-gray-400"> · “{myCall.note}”</span>}
    </div>
  )
  // the coach's call next to yours, in the box that shows yours (founder's pick A, round 2)
  const coach = review?.call ?? null
  const callBox = coach ? (
    <div className={cn('mt-3 border border-gray-800 rounded-md', t)} style={boxStyle}>
      <div className={cn('grid gap-x-2 gap-y-1.5 leading-snug', big ? 'p-3' : 'px-2.5 py-2')} style={{ gridTemplateColumns: '48px minmax(0, 1fr)' }}>
        {myCall && (
          <>
            <span className="text-gray-400">You</span>
            <span><b className={cn('font-semibold', CALL_WORD[myCall.call].cls)}>{CALL_WORD[myCall.call].label}</b>{myCall.note && <span className="text-gray-400"> · “{myCall.note}”</span>}</span>
          </>
        )}
        <span className="text-gray-400">Coach</span>
        <span className="text-gray-100"><b className={cn('font-semibold', CALL_WORD[coach.kind].cls)}>{CALL_WORD[coach.kind].label}</b> · {coach.why}</span>
      </div>
      {myCall && (
        <div className={cn('border-t border-gray-800 text-gray-400', big ? 'px-3 py-2 text-[12.5px]' : 'px-2.5 py-1.5 text-[11.5px]')}>
          {myCall.call === coach.kind ? 'The same call as yours.' : 'A different call from yours.'}
        </div>
      )}
    </div>
  ) : echo
  // your day at the fill: worked out from your trades and rules when it was asked, not by the AI
  const dayBlock = review?.day?.length ? (
    <div className={box} style={boxStyle}>
      <div className="flex items-baseline justify-between">
        <span className={cn('font-semibold uppercase tracking-[.8px] text-gray-400', big ? 'text-[11px]' : 'text-[10.5px]')}>Your day at the fill</span>
        <span className={cn('text-gray-400', small)}>your rules</span>
      </div>
      {review.day.map((l, k) => (
        <div key={k} className={cn('grid gap-2 py-1.5 border-b border-gray-800 last:border-b-0 leading-snug text-gray-100', t)} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
          <span>{l.fact}</span>
          {l.status && <span className={cn('whitespace-nowrap font-semibold', small, !l.broken && 'text-gray-300')} style={l.broken ? { color: caution.color } : undefined}>{l.status}</span>}
        </div>
      ))}
    </div>
  ) : null
  const limitBox = (withSave: boolean) => (
    <div className={box} style={boxStyle}>
      <div className={cn('font-semibold text-gray-100', big ? 'text-[14.5px]' : 'text-[13.5px]')}>Today’s {usage?.limit ?? ''} are used</div>
      <p className={cn('mt-1.5 leading-snug text-gray-400', t, withSave && 'mb-3')}>Saved Coach Reviews still open. More after midnight Pacific.</p>
      {withSave && <button type="button" onClick={saveOnly} disabled={!draft?.call} className={cn(secondary, 'disabled:opacity-50')}>Save my call</button>}
    </div>
  )

  let body: React.ReactNode
  if (phase === 'error') {
    body = (
      <div className={box} style={boxStyle}>
        <div className={cn('font-semibold text-gray-100', big ? 'text-[14.5px]' : 'text-[13.5px]')}>Couldn’t get one just now</div>
        <p className={cn('mt-1.5 mb-3 leading-snug text-gray-400', t)}>{err === 'Couldn\'t get one just now.' ? 'Your call is saved. Try again in a moment.' : err}</p>
        <button type="button" onClick={unlocked ? ask : saveAndAsk} className={secondary}>Try again</button>
      </div>
    )
  } else if (busy) {
    body = (
      <div className={box} style={boxStyle}>
        <div className={cn('font-semibold text-gray-100', t)}>{phase === 'saving' ? 'Saving your call…' : 'Your call is saved.'}</div>
        <p className={cn('mt-1.5 text-gray-400', t)}>Reading the chart at your fill…</p>
        <div className="mt-2.5 h-[3px] rounded-sm overflow-hidden" style={{ background: 'var(--ts-line)' }}><div className="h-[3px] w-[45%] bg-blue-500 animate-pulse" /></div>
      </div>
    )
  } else if (!unlocked) {
    body = none ? limitBox(true) : (
      <>
        <div className={cn(box, 'pt-3.5')} style={boxStyle}>
          <div className={cn('flex items-center gap-2 font-semibold text-gray-100', big ? 'text-[14.5px]' : 'text-[13.5px]')}><LockIcon size={big ? 16 : 15} />Make your call first</div>
          <p className={cn('mt-1.5 mb-3 leading-snug text-gray-400', t)}>
            {full ? 'It opens once your call is saved. It still reads only what printed before your fill.' : 'It opens once your call is saved, so your read stays your own.'}
            {big && ' Pick Good, Mistake or Unsure below.'}
          </p>
          <button type="button" onClick={saveAndAsk} disabled={!draft?.call} className={primary}>Save my call and ask</button>
          {left && <div className={cn('mt-1.5 text-center text-gray-400', small)}>{left}</div>}
        </div>
        <div className={cap}>What it reads</div>
        <p className={cn('leading-normal text-gray-300', big ? 'text-[13px]' : 'text-[12px]')}>
          Only what printed before your fill: 1m and 5m candles, levels, VWAP and EMAs, {orderFlow ? 'bubbles and footprint, ' : ''}your stop and target, your entry rules{orderFlow ? ' and order-flow Score' : ''}, your day so far against your rules, and your profile.
        </p>
        <div className={cap}>What it never sees</div>
        <p className={cn('leading-normal text-gray-300', big ? 'text-[13px]' : 'text-[12px]')}>
          Your result, your exit, anything after your fill, your tags, notes and screenshot. Not your call either, so it can’t just agree with you.
        </p>
      </>
    )
  } else if (!data) {
    body = <p className={cn('mt-3 text-gray-400', t)}>Loading…</p>
  } else if (review) {
    const groups = GROUPS.map(g => ({ ...g, items: review.items.filter(i => i.kind === g.kind) })).filter(g => g.items.length)
    body = (
      <>
        {data.stale && (
          <div className={cn('mt-2.5 px-2.5 py-2 rounded leading-snug', big ? 'text-[13px]' : 'text-[12px]')} style={caution}>
            {data.stale}{' '}
            {none ? <span>None left today.</span> : <><button type="button" onClick={ask} className="font-semibold text-blue-400 hover:text-blue-300">Ask again</button> · uses 1 of today’s {usage?.limit ?? ''}</>}
          </div>
        )}
        {full && <p className={cn('mt-2 text-gray-400', big ? 'text-[13px]' : 'text-[12px]')}>From the fill. It never sees what happened next.</p>}
        {callBox}
        {dayBlock}
        {groups.map(g => (
          <div key={g.kind}>
            <div className={cap}>{g.label}</div>
            {g.items.map((it, k) => (
              <div key={k} className={cn('flex gap-2 mb-[7px] leading-snug text-gray-100', t)}>
                <span aria-hidden className="flex-none w-2.5 font-mono font-semibold text-gray-400">{g.mark}</span>
                <span>{it.text}</span>
              </div>
            ))}
          </div>
        ))}
        <div className={cn('mt-3 px-2.5 py-2 rounded leading-snug text-gray-100', big ? 'text-[13px]' : 'text-[12px]')} style={boxStyle}>
          <b className="font-semibold">Couldn’t see:</b> {review.unseen.join(', ')}. Nothing after {review.cutoff}.
        </div>
        {!review.of && <p className={cn('mt-2 text-gray-400', big ? 'text-[13px]' : 'text-[12px]')}>Order flow left out: your profile doesn’t trade it.</p>}
        <p className={cn('mt-2.5 leading-snug text-gray-400', small)}>
          From what printed before {review.fill} PT. Asked {asked(review.at)}. Saved on the trade, so opening it again uses nothing.
        </p>
      </>
    )
  } else if (data.tooOld) {
    body = (
      <div className={box} style={boxStyle}>
        <div className={cn('font-semibold text-gray-100', big ? 'text-[14.5px]' : 'text-[13.5px]')}>No Coach Review for this trade</div>
        <p className={cn('mt-1.5 leading-snug text-gray-400', t)}>The site keeps 90 days of tick data and this trade is older.</p>
      </div>
    )
  } else if (none) {
    body = <>{echo}{limitBox(false)}</>
  } else {
    body = (
      <>
        <div className={box} style={boxStyle}>
          {myCall && (
            <div className={cn('mb-2.5', t)}>
              Your call <b className={cn('font-semibold', CALL_WORD[myCall.call].cls)}>{CALL_WORD[myCall.call].label}</b>
              {myCall.note && <span className="text-gray-400"> · “{myCall.note}”</span>}
            </div>
          )}
          <button type="button" onClick={ask} className={primary}>Get a Coach Review</button>
          {left && <div className={cn('mt-1.5 text-center text-gray-400', small)}>{left}</div>}
        </div>
        <p className={cn('mt-2.5 leading-normal text-gray-300', big ? 'text-[13px]' : 'text-[12px]')}>It reads only what printed before your fill{full ? ', in Full review too' : ''}.</p>
      </>
    )
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className={cn('font-semibold text-gray-100', big ? 'text-[15px]' : 'text-[13.5px]')}>Coach Review</span>
        <span className={cn('text-gray-400', small)}>{sub}</span>
      </div>
      {body}
    </div>
  )
}
