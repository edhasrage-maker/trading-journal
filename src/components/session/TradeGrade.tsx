'use client'

/**
 * A trade's Score — its grade, Entry and Exit averaged (src/lib/trade-grade.ts;
 * founder-approved mockup docs/trade-grade-mockup.html, 2026-10-15). One chip in
 * the Recap's Score column; click it for every reason in one panel: the
 * trader's entry rules and the order-flow Score's five reasons under Entry;
 * profit kept, stop respected and their runner rules under Exit; on a quick
 * re-entry after a loss, "Waited after a loss" (docs/chase-score-mockup.html).
 */
import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { TradeGrade } from '@/lib/trade-grade'

export function GradeChip({ grade, open, onToggle }: { grade: TradeGrade; open: boolean; onToggle: () => void }) {
  if (grade.score == null) return <span className="text-gray-700" title="Nothing about this trade could be graded yet.">—</span>
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle() }}
      aria-expanded={open}
      title="This trade's grade: Entry and Exit averaged. Click for every reason."
      className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-1.5 py-0.5 rounded border border-gray-700 bg-gray-900 text-gray-200 hover:border-gray-500 shrink-0 leading-none align-middle ${open ? 'ring-1 ring-blue-400/60' : ''}`}
    >
      <span className="tabular-nums">{grade.score}</span>
      {open ? <ChevronUp className="w-3 h-3 opacity-60" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
    </button>
  )
}

const DOT = { pass: 'bg-emerald-400', fail: 'bg-red-400', unknown: 'bg-gray-600' } as const
const WORD = { pass: 'text-emerald-400', fail: 'text-red-400', unknown: 'text-gray-500' } as const
const FACT_DOT: Record<string, keyof typeof DOT> = { with: 'pass', against: 'fail', neutral: 'unknown' }

type Line = { key: string; dot: keyof typeof DOT; label: string; title?: string; status: string; statusCls: string; text: string; muted?: boolean; greyed?: boolean }

function Lines({ lines, wide }: { lines: Line[]; wide?: boolean }) {
  if (!lines.length) return null
  return (
    <div className={`grid ${wide ? 'grid-cols-[10px_minmax(150px,230px)_64px_minmax(0,1fr)]' : 'grid-cols-[10px_minmax(110px,190px)_64px_minmax(0,1fr)]'} gap-x-2.5 gap-y-1 items-baseline`}>
      {lines.map(l => (
        <div key={l.key} className={`contents ${l.greyed ? '[&>*]:opacity-50' : ''}`}>
          <span className={`w-1.5 h-1.5 rounded-full self-center ${DOT[l.dot]}`} aria-hidden="true" />
          <span className={wide ? 'font-semibold text-gray-200' : 'text-gray-500'} title={l.title}>{l.label}</span>
          <span className={l.statusCls}>{l.status}</span>
          <span className={l.muted ? 'text-gray-500' : ''}>{l.text}</span>
        </div>
      ))}
    </div>
  )
}

const r = (x: number | null) => (x == null ? null : Math.round(x))
const ptHms = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles' })

/** The Score's headline: Entry, Exit and (on a re-entry after a loss) Waited. */
function scoreTail(g: TradeGrade) {
  return `· Entry ${g.entry ?? '—'} · Exit ${g.exit ?? '—'}${g.parts.waited != null ? ` · Waited ${r(g.parts.waited)}` : ''}`
}

const WAITED_NOTE = 'A trade entered within 5 minutes of a losing exit gets this third part. With a fresh trigger tagged (an entry model other than "Based on Price") it scores 100; without one, 0.'

/** Every reason behind a trade's Score, as lines — shared by the Recap's panel and Replay Review's narrow one, so both say the same thing. */
function gradeLines(g: TradeGrade, neverWent: boolean, hasStop: boolean) {
  const p = g.parts
  const known = (xs: { status: string }[]) => xs.filter(x => x.status !== 'unknown')
  const passed = (xs: { status: string }[]) => xs.filter(x => x.status === 'pass').length

  // ── Entry ──
  const er = g.entryResults
  const entryBits = [
    er.length && p.entryRules != null ? `your entry rules ${r(p.entryRules)} (${passed(er.filter(x => x.counted))} of ${known(er.filter(x => x.counted)).length})` : null,
    g.flowScore && p.flow != null ? `order-flow Score ${r(p.flow)}` : null,
  ].filter(Boolean)
  const ruleLines: Line[] = er.map(x => ({
    key: x.id, dot: x.status, label: x.label, title: x.name, status: x.status, statusCls: WORD[x.status], text: x.reason, greyed: !x.counted,
  }))
  const factLines: Line[] = (g.flowScore?.facts ?? []).map(f => ({
    key: f.k, dot: FACT_DOT[f.state] ?? 'unknown', label: f.label, status: `${f.pts}/${f.max}`, statusCls: 'text-gray-500', text: f.text,
  }))

  // ── Exit ──
  const rr = g.runnerResults ?? []
  const exitBits = [
    p.kept != null ? `profit kept ${r(p.kept)}` : null,
    p.stopRespected != null ? `stop respected ${r(p.stopRespected)}` : null,
    p.runner != null ? (p.runnerOwn ? `runner rules ${r(p.runner)} (${passed(rr.filter(x => x.counted))} of ${known(rr.filter(x => x.counted)).length})` : `runner ${r(p.runner)}`) : null,
  ].filter(Boolean)
  const exitLines: Line[] = []
  if (p.kept != null) {
    exitLines.push(p.kept >= 99.5
      ? { key: 'kept', dot: 'pass', label: 'Profit kept', status: '100%', statusCls: WORD.pass, text: g.exitKind === 'target' ? 'Reached your target.' : 'Kept the best point the trade reached.' }
      : { key: 'kept', dot: 'fail', label: 'Profit kept', status: `${r(p.kept)}%`, statusCls: 'text-gray-400', text: `Kept ${r(p.kept)}% of the best point the trade reached.` })
  } else if (neverWent) {
    exitLines.push({ key: 'kept', dot: 'unknown', label: 'Profit kept', status: '—', statusCls: WORD.unknown, text: 'Never got 1×ATR your way: not an exit to grade.', muted: true })
  }
  if (p.stopRespected === 100) {
    exitLines.push({ key: 'stop', dot: 'pass', label: 'Stop respected', status: 'yes', statusCls: WORD.pass, text: g.exitKind === 'stopped' ? 'Out at your stop, within slippage.' : 'Price came to your stop and didn\'t trade past it.' })
  } else if (p.stopRespected === 0) {
    exitLines.push({ key: 'stop', dot: 'fail', label: 'Stop respected', status: 'no', statusCls: WORD.fail, text: 'Price traded past your stop by more than slippage while you were in.' })
  } else {
    exitLines.push({ key: 'stop', dot: 'unknown', label: 'Stop respected', status: '—', statusCls: WORD.unknown, text: hasStop ? 'Your stop never came into play.' : 'No stop logged.', muted: true })
  }
  if (p.runner != null && !p.runnerOwn) {
    exitLines.push({ key: 'runner', dot: p.runner >= 99.5 ? 'pass' : 'fail', label: 'Runner', status: `${r(p.runner)}`, statusCls: 'text-gray-400', text: 'Went for a second target: TP1 filled and the 5-minute structure with you.' })
  }
  const runnerLines: Line[] = rr.map(x => ({
    key: x.id, dot: x.status, label: x.label, title: x.name, status: x.status, statusCls: WORD[x.status], text: x.reason, greyed: !x.counted,
  }))

  // ── Waited after a loss ──
  const re = g.reentry
  const waitedLines: Line[] = []
  if (re && g.parts.waited != null) {
    const after = `your ${ptHms(re.afterExit)} ${re.afterStopOut ? 'stop-out' : 'loss'}`
    const fresh = re.triggers.filter(x => x.trim().toLowerCase() !== 'based on price')
    waitedLines.push(re.fresh
      ? { key: 'waited', dot: 'pass', label: 'Waited after a loss', status: 'yes', statusCls: WORD.pass, text: `${re.gapSec} s after ${after}, with a fresh trigger: ${fresh.join(', ')}.` }
      : { key: 'waited', dot: 'fail', label: 'Waited after a loss', status: 'no', statusCls: WORD.fail, text: re.triggers.length
          ? `In ${re.gapSec} s after ${after}, with only "Based on Price" as the trigger.`
          : `In ${re.gapSec} s after ${after}, with no fresh trigger tagged.` })
  }

  const readAt = g.flowScore?.read_at ?? null
  const tapeRule = er.some(x => /Tape Reader/.test(x.reason) && x.status !== 'unknown')
  const greyed = er.some(x => !x.counted) || rr.some(x => !x.counted)
  const fmt = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 10) / 10).toFixed(1)}`
  const tapeNums = g.entryCtx?.tape != null && g.entryCtx?.tape_clock != null ? `${fmt(g.entryCtx.tape)} and ${fmt(g.entryCtx.tape_clock)}` : null
  return { entryBits, ruleLines, factLines, exitBits, exitLines, runnerLines, waitedLines, readAt, tapeRule, greyed, tapeNums }
}

/** Every reason behind a trade's Score, under Entry and Exit. */
export function TradeGradeDetail({ grade: g, neverWent, hasStop }: {
  grade: TradeGrade
  /** The trade never got 1×ATR its way (Kept reads N/A). */
  neverWent: boolean
  hasStop: boolean
}) {
  const { entryBits, ruleLines, factLines, exitBits, exitLines, runnerLines, waitedLines, readAt, tapeRule, greyed, tapeNums } = gradeLines(g, neverWent, hasStop)
  return (
    <div className="font-sans text-xs text-gray-300 py-2 max-w-3xl space-y-2.5">
      <p className="text-[13px] font-semibold text-gray-100">
        Score {g.score ?? '—'} <span className="font-normal text-gray-400">{scoreTail(g)}</span>
      </p>
      {waitedLines.length > 0 && (
        <div className="border-l-2 border-blue-500/60 pl-2.5 space-y-1.5">
          <p className="text-gray-400 font-semibold">Waited after a loss {r(g.parts.waited)}</p>
          <Lines lines={waitedLines} />
        </div>
      )}
      {(g.entry != null || ruleLines.length > 0 || factLines.length > 0) && (
        <div className="border-l-2 border-gray-800 pl-2.5 space-y-1.5">
          <p className="text-gray-400 font-semibold">Entry {g.entry ?? '—'}{entryBits.length ? ` · ${entryBits.join(' · ')}` : ''}</p>
          <Lines lines={ruleLines} wide />
          <Lines lines={factLines} />
        </div>
      )}
      {(g.exit != null || runnerLines.length > 0) && (
        <div className="border-l-2 border-gray-800 pl-2.5 space-y-1.5">
          <p className="text-gray-400 font-semibold">Exit {g.exit ?? '—'}{exitBits.length ? ` · ${exitBits.join(' · ')}` : ''}</p>
          <Lines lines={exitLines} />
          <Lines lines={runnerLines} wide />
        </div>
      )}
      {(readAt || greyed || waitedLines.length > 0) && (
        <p className="text-[11px] text-gray-600">
          {waitedLines.length > 0 && <>{WAITED_NOTE} </>}
          {readAt && <>Entry reads only what printed before your fill at {readAt} PT.</>}
          {readAt && tapeRule && g.flowScore && <> The two Tape Reader numbers{tapeNums ? ` (${tapeNums})` : ''} are two windows of the same study: your rules use the 480 s before the fill (your research); the order-flow Score uses 8 clock minutes (your chart).</>}
          {greyed && <>{readAt ? ' ' : ''}Greyed rules started after this trade, so they don&apos;t count toward its Score.</>}
        </p>
      )}
    </div>
  )
}

/** One reason per row in a narrow column: dot, label and status, the why underneath. */
function CompactLines({ lines, big }: { lines: Line[]; big?: boolean }) {
  return (
    <>
      {lines.map(l => (
        <div key={l.key} className={`grid grid-cols-[10px_minmax(0,1fr)_auto] gap-x-2 gap-y-px items-baseline ${big ? 'py-[5px] text-[13px]' : 'py-1 text-[12px]'} ${l.greyed ? 'opacity-50' : ''}`}>
          <span className={`w-1.5 h-1.5 rounded-full self-center ${DOT[l.dot]}`} aria-hidden="true" />
          <span className="font-semibold text-gray-100" title={l.title}>{l.label}</span>
          <span className={l.statusCls}>{l.status}</span>
          <span />
          <span className="col-span-2 text-gray-400">{l.text}</span>
        </div>
      ))}
    </>
  )
}

/**
 * The same Score and reasons as TradeGradeDetail, laid out for a narrow
 * column (Replay Review's "Your trade" panel, phone tab): the five order-flow
 * reasons sit behind a toggle so the panel stays short.
 */
export function TradeGradeCompact({ grade: g, neverWent, hasStop, note, big = false }: {
  grade: TradeGrade
  neverWent: boolean
  hasStop: boolean
  /** Replaces the footnote (e.g. why there's no Entry part). */
  note?: string | null
  big?: boolean
}) {
  const [facts, setFacts] = useState(false)
  const { entryBits, ruleLines, factLines, exitBits, exitLines, runnerLines, waitedLines, readAt, greyed } = gradeLines(g, neverWent, hasStop)
  const head = `font-semibold text-gray-400 ${big ? 'text-[12.5px]' : 'text-[12px]'}`
  return (
    <div className="font-sans">
      <p className={`font-semibold tabular-nums text-gray-100 ${big ? 'text-[16px]' : 'text-[15px]'}`}>
        Score {g.score ?? '—'} <span className="font-normal text-gray-400">{scoreTail(g)}</span>
      </p>
      {waitedLines.length > 0 && (
        <div className="mt-2 pl-2.5 border-l-2 border-blue-500/60">
          <p className={head}>Waited after a loss {r(g.parts.waited)}</p>
          <CompactLines lines={waitedLines} big={big} />
        </div>
      )}
      {(g.entry != null || ruleLines.length > 0 || factLines.length > 0) && (
        <div className="mt-2 pl-2.5 border-l-2 border-gray-800">
          <p className={head}>Entry {g.entry ?? '—'}{entryBits.length ? ` · ${entryBits.join(' · ')}` : ''}</p>
          <CompactLines lines={ruleLines} big={big} />
          {factLines.length > 0 && (
            <>
              {facts && <CompactLines lines={factLines} big={big} />}
              <button type="button" onClick={() => setFacts(v => !v)} className={`mt-0.5 text-blue-400 hover:text-blue-300 ${big ? 'text-[13px]' : 'text-[12px]'}`}>
                {facts ? 'Hide the order-flow reasons' : `Show the ${factLines.length} order-flow reasons`}
              </button>
            </>
          )}
        </div>
      )}
      {(g.exit != null || runnerLines.length > 0 || exitLines.length > 0) && (
        <div className="mt-2.5 pl-2.5 border-l-2 border-gray-800">
          <p className={head}>Exit {g.exit ?? '—'}{exitBits.length ? ` · ${exitBits.join(' · ')}` : ''}</p>
          <CompactLines lines={exitLines} big={big} />
          <CompactLines lines={runnerLines} big={big} />
        </div>
      )}
      {(note || readAt || greyed) && (
        <p className="mt-2 text-[11.5px] text-gray-500">
          {note ?? <>
            {readAt && <>Entry reads only what printed before your fill at {readAt} PT.</>}
            {greyed && <>{readAt ? ' ' : ''}Greyed rules started after this trade, so they don&apos;t count toward its Score.</>}
          </>}
        </p>
      )}
    </div>
  )
}
