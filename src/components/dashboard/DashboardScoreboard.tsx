'use client'

import type { ReactNode } from 'react'
import { tapeScoreBand, tapeScorePeriodSentence } from '@/lib/tapescore'
import { AXIS_DESC, axisTooltip } from '@/lib/tapescore-axes'
import type { Finding } from '@/lib/dashboard-read'
import { CompositionRing, ScoreBreakdownInfo } from '@/components/review/ReviewMonthHero'
import { fmtSignedUsd, type PeriodStats } from './DashboardStats'

/**
 * The Detailed dashboard's scoreboard (founder, 2026-11-01 — "scoreboard"
 * mockup): what the period says in one sentence, Net P&L beside it, then the
 * TapeScore, win rate · R:R and green days in ruled columns. Sits inside the
 * navy `.ts-band`, so every colour here is a --b-* variable (globals.css),
 * never a theme ramp.
 *
 * Same numbers as the stat cards Highlights shows: both read
 * computePeriodStats.
 */

const MUT = 'text-[var(--b-mut)]'
const INK = 'text-[var(--b-ink)]'
const POS = 'text-[var(--b-pos)]'
const NEG = 'text-[var(--b-neg)]'
const BIG = `${INK} font-bold leading-none tabular-nums whitespace-nowrap tracking-[-0.02em]`
const display = { fontFamily: 'var(--font-display)' }

const moneyClass = (n: number) => (n > 0.5 ? POS : n < -0.5 ? NEG : MUT)

function BandBar({ label, frac, color, value, valueClass, faint = false }: {
  label: string
  frac: number
  color: string
  value: string
  valueClass: string
  faint?: boolean
}) {
  return (
    <div className={`grid grid-cols-[minmax(0,108px)_1fr_auto] items-center gap-2.5 text-[14px] ${MUT}`}>
      <span className="truncate" title={label}>{label}</span>
      <span className="h-1.5 rounded-full bg-[var(--b-track)] overflow-hidden">
        <span
          className={`block h-full rounded-full ${faint ? 'opacity-60' : ''}`}
          style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, background: color }}
        />
      </span>
      <b className={`text-right tabular-nums ${valueClass}`}>{value}</b>
    </div>
  )
}

function Col({ label, info, children, className = '' }: { label: string; info?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 flex flex-col gap-2.5 ${className}`}>
      <div className={`flex items-center gap-1.5 text-[14px] ${MUT}`}>{label}{info}</div>
      {children}
    </div>
  )
}

/** The finding: one sentence, the trade-count table under it, a plain note.
 *  With enough days before the period the table gains a "Before" column (the
 *  same cut's average day back then), so the counter-argument sits in the
 *  rows it argues with; Green drops on a phone to make room. */
function FindingBlock({ finding, fallback }: { finding: Finding | null; fallback: string }) {
  const s = finding?.split
  const h = finding?.history ?? null
  const greenCol = h ? 'hidden sm:table-cell' : ''
  const th = `pb-1.5 pl-3 sm:pl-5 text-right font-normal text-[13px] ${MUT}`
  const td = `py-1.5 pl-3 sm:pl-5 text-right font-bold tabular-nums whitespace-nowrap text-[16px] sm:text-[20px] border-t border-[var(--b-rule)]`
  const row = (label: string, short: string, g: NonNullable<typeof s>['few'], before: number | null) => (
    <tr>
      <th scope="row" className={`py-1.5 text-left font-semibold text-[14px] sm:text-[15px] border-t border-[var(--b-rule)] ${INK}`}>
        <span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span>
      </th>
      <td className={`${td} ${INK}`} style={display}>{g.days}</td>
      <td className={`${td} ${INK} ${greenCol}`} style={display}>{g.green === g.days ? `all ${g.days}` : `${g.green} of ${g.days}`}</td>
      <td className={`${td} ${moneyClass(g.avg)}`} style={display}>{fmtSignedUsd(g.avg)}</td>
      {before != null && <td className={`${td} ${moneyClass(before)}`} style={display}>{fmtSignedUsd(before)}</td>}
      <td className={`${td} ${INK}`} style={display}>{g.scoreMin == null ? '—' : g.scoreMin === g.scoreMax ? g.scoreMin : `${g.scoreMin}–${g.scoreMax}`}</td>
    </tr>
  )
  return (
    <div className="min-w-0 max-w-[820px]">
      <div className={`text-[14px] font-semibold ${POS}`}>What this period says</div>
      <h1 className={`mt-2 text-[26px] sm:text-[34px] leading-[1.12] font-bold tracking-[-0.015em] ${INK}`} style={display}>
        {finding?.headline ?? fallback}
      </h1>
      {finding?.bridge && <p className={`mt-3 text-[16px] sm:text-[17px] leading-snug ${INK}`}>{finding.bridge}</p>}
      {s && (
        <table className="mt-4 w-full max-w-[640px] border-collapse">
          <thead>
            <tr>
              <th className={`${th} pl-0 text-left`}><span className="sr-only">Days with</span></th>
              <th className={th}>Days</th>
              <th className={`${th} ${greenCol}`}>Green</th>
              <th className={th}>Avg day</th>
              {h && <th className={th} title={`Average day over the ${h.few.days + h.many.days} days before this period`}>Before</th>}
              <th className={th}>TapeScore</th>
            </tr>
          </thead>
          <tbody>
            {row(`${s.k} trade${s.k === 1 ? '' : 's'} or fewer`, `≤${s.k} trades`, s.few, h ? h.few.avg : null)}
            {row(`${s.k + 1} or more`, `${s.k + 1}+ trades`, s.many, h ? h.many.avg : null)}
          </tbody>
        </table>
      )}
      {finding?.note && <p className={`mt-3 text-[15px] leading-relaxed ${MUT}`}>{finding.note}</p>}
      {finding?.verdict && (
        <p className={`mt-3 pl-3 border-l-2 border-[var(--b-pos)] text-[16px] sm:text-[17px] font-semibold leading-snug ${INK}`}>{finding.verdict}</p>
      )}
    </div>
  )
}

const AXES = [
  { key: 'risk' as const, name: 'Risk', tip: AXIS_DESC.risk },
  { key: 'entry' as const, name: 'Entry', tip: AXIS_DESC.entry },
  { key: 'exit' as const, name: 'Exit', tip: AXIS_DESC.exit },
]

export default function DashboardScoreboard({ stats, finding }: { stats: PeriodStats; finding: Finding | null }) {
  const tp = stats.tapePeriod
  const fallback = tapeScorePeriodSentence(tp) ?? 'Not enough scored days to read this period yet.'

  // Net P&L against the stretch just before (or the average day for All time).
  const prior = stats.prior
  const priorMax = Math.max(Math.abs(stats.pnl), Math.abs(prior?.pnl ?? 0)) || 1
  const diff = prior ? stats.pnl - prior.pnl : 0

  const green = stats.daily.filter(v => v > 0)
  const red = stats.daily.filter(v => v < 0)
  const avgGreen = green.length ? green.reduce((s, v) => s + v, 0) / green.length : null
  const avgRed = red.length ? red.reduce((s, v) => s + v, 0) / red.length : null
  const gMax = Math.max(avgGreen ?? 0, Math.abs(avgRed ?? 0)) || 1
  const ratio = avgGreen != null && avgRed != null ? Math.abs(avgRed) / avgGreen : null

  const below = stats.payoffR != null && stats.breakEvenPayoff != null && stats.payoffR <= stats.breakEvenPayoff

  return (
    <>
      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <FindingBlock finding={finding} fallback={fallback} />

        <div className="min-w-0 flex flex-col gap-2.5 lg:pl-8 lg:border-l border-[var(--b-rule)]">
          <div className={`text-[14px] ${MUT}`}>Net P&amp;L</div>
          <div className={`text-[44px] sm:text-[56px] font-bold leading-none tabular-nums tracking-[-0.02em] ${moneyClass(stats.pnl)}`} style={display}>
            {fmtSignedUsd(stats.pnl)}
          </div>
          <div className={`text-[14px] mb-2 ${MUT}`}>
            {stats.tradedDaysCount} trading day{stats.tradedDaysCount === 1 ? '' : 's'} · {stats.totalTradesWithPnl} trade{stats.totalTradesWithPnl === 1 ? '' : 's'}
          </div>
          {prior == null ? (
            stats.tradedDaysCount > 0 && (
              <p className={`text-[14px] ${MUT}`}>
                Average trading day <b className={`tabular-nums ${moneyClass(stats.pnl / stats.tradedDaysCount)}`}>{fmtSignedUsd(stats.pnl / stats.tradedDaysCount)}</b>
              </p>
            )
          ) : prior.days === 0 ? (
            <p className={`text-[14px] ${MUT}`}>No trades in {prior.label} to compare with.</p>
          ) : (
            <>
              <BandBar label="This period" frac={Math.abs(stats.pnl) / priorMax} color={stats.pnl >= 0 ? 'var(--b-pos)' : 'var(--b-neg)'} value={fmtSignedUsd(stats.pnl)} valueClass={moneyClass(stats.pnl)} />
              <BandBar
                label={prior.label.replace(/^the /, '').replace(/^./, c => c.toUpperCase())}
                frac={Math.abs(prior.pnl) / priorMax}
                color={prior.pnl >= 0 ? 'var(--b-pos)' : 'var(--b-neg)'}
                value={fmtSignedUsd(prior.pnl)}
                valueClass={moneyClass(prior.pnl)}
                faint
              />
              <p className={`text-[14px] ${MUT}`}>
                {Math.abs(diff) < 0.5
                  ? `Level with ${prior.label}.`
                  : <><b className={diff > 0 ? POS : NEG}>{fmtSignedUsd(Math.abs(diff)).replace('+', '')} {diff > 0 ? 'more' : 'less'}</b> than {prior.label}</>}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="mt-7 pt-6 border-t border-[var(--b-rule)] grid gap-8 md:grid-cols-2 xl:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] xl:gap-0">
        {/* TapeScore — the ring stays (founder, 2026-11-01). */}
        <div className="min-w-0 xl:pr-8 flex items-center gap-5">
          {tp.score != null ? (
            <>
              <CompositionRing score={tp.score} subs={{ risk: tp.risk ?? 0, entry: tp.entry ?? 0, exit: tp.exit ?? 0 }} size={124} onBand />
              <div className="flex-1 min-w-[170px] flex flex-col gap-2">
                <div className={`flex items-center gap-1.5 text-[14px] ${MUT} [&_button]:text-[var(--b-mut)]`}>
                  TapeScore <ScoreBreakdownInfo period={tp} />
                </div>
                {AXES.map(a => {
                  const v = tp[a.key]
                  return (
                    <div key={a.key} className={`grid grid-cols-[44px_1fr_26px] items-center gap-2 text-[14px] ${MUT}`} title={axisTooltip(`${a.name} (0-100), over the period: ${a.tip}.`, tp.parts, a.key)}>
                      <span>{a.name}</span>
                      <span className="h-1.5 rounded-full bg-[var(--b-track)] overflow-hidden">
                        {v != null && <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: `var(--b-score-${tapeScoreBand(v)})` }} />}
                      </span>
                      <b className={`text-right tabular-nums ${INK}`}>{v ?? '—'}</b>
                    </div>
                  )
                })}
                <p className={`text-[13px] ${MUT}`}>How well you traded, apart from the money</p>
              </div>
            </>
          ) : (
            <Col label="TapeScore">
              <div className={BIG} style={{ ...display, fontSize: 44 }}>—</div>
              <p className={`text-[14px] ${MUT}`}>No graded sessions in this period yet. Run Analyze Session on a day to score it.</p>
            </Col>
          )}
        </div>

        {/* Win rate and R:R, the same size — they only mean something together. */}
        <div className="min-w-0 flex flex-col gap-2.5 xl:px-8 xl:border-l border-[var(--b-rule)]">
          <div
            className="flex flex-wrap gap-x-8 gap-y-3"
            title={`Win rate, and how much bigger the average winner is than the average loser (in R, so position sizing doesn't distort it). Win rate counts ${stats.totalTradesWithPnl} trades; R:R counts the ${stats.rSample} with a stop logged.`}
          >
            <div>
              <div className={`text-[14px] mb-1.5 ${MUT}`}>Win rate</div>
              <div className={BIG} style={{ ...display, fontSize: 44 }}>{stats.tradeWinRate == null ? '—' : `${Math.round(stats.tradeWinRate * 100)}%`}</div>
            </div>
            {stats.payoffR != null && (
              <div>
                <div className={`text-[14px] mb-1.5 ${MUT}`}>R:R</div>
                <div className={`${BIG} ${below ? '!text-[#E5B867]' : ''}`} style={{ ...display, fontSize: 44 }}>{stats.payoffR.toFixed(1)} : 1</div>
              </div>
            )}
          </div>
          {stats.payoffR != null && stats.breakEvenPayoff != null ? (
            <p className={`text-[14px] leading-snug ${MUT}`}>
              Winners pay {stats.payoffR.toFixed(1)}R for every 1R lost. You only need {stats.breakEvenPayoff.toFixed(2)}R to break even, so{' '}
              {below ? <b className="text-[#E5B867]">you&rsquo;re below it</b> : <b className={POS}>you&rsquo;re above it</b>}.
              {stats.rSample * 2 < stats.totalTradesWithPnl && <> (R:R from {stats.rSample} of {stats.totalTradesWithPnl} trades)</>}
            </p>
          ) : (
            <p className={`text-[14px] ${MUT}`}>{stats.totalTradesWithPnl} trade{stats.totalTradesWithPnl === 1 ? '' : 's'}</p>
          )}
          {stats.tradeWinRate != null && (
            <div>
              <div className="flex h-1.5 rounded-full overflow-hidden" aria-hidden="true">
                <span style={{ width: `${Math.round(stats.tradeWinRate * 100)}%`, background: 'var(--b-pos)' }} />
                <span style={{ width: `${100 - Math.round(stats.tradeWinRate * 100)}%`, background: '#6A3A4A' }} />
              </div>
              <div className={`mt-1.5 flex justify-between text-[13px] ${MUT}`}>
                <span>Wins {Math.round(stats.tradeWinRate * 100)}%</span>
                <span>Losses {100 - Math.round(stats.tradeWinRate * 100)}%</span>
              </div>
            </div>
          )}
        </div>

        {/* Green days: how often, then how big. */}
        <Col label="Green days" className="xl:pl-8 xl:border-l border-[var(--b-rule)] md:col-span-2 xl:col-span-1">
          {stats.tradedDaysCount === 0 ? (
            <p className={`text-[14px] ${MUT}`}>No trading days yet.</p>
          ) : (
            <>
              <div className={BIG} style={{ ...display, fontSize: 44 }}>{stats.winDays} of {stats.tradedDaysCount}</div>
              <p className={`text-[14px] ${MUT}`}>{Math.round((stats.dayWinRate ?? 0) * 100)}% of your days finished green</p>
              <BandBar label="Avg green day" frac={(avgGreen ?? 0) / gMax} color="var(--b-pos)" value={avgGreen == null ? '—' : fmtSignedUsd(avgGreen)} valueClass={avgGreen == null ? MUT : POS} />
              <BandBar label="Avg red day" frac={Math.abs(avgRed ?? 0) / gMax} color="var(--b-neg)" value={avgRed == null ? '—' : fmtSignedUsd(avgRed)} valueClass={avgRed == null ? MUT : NEG} />
              <p className={`text-[14px] ${MUT}`}>
                {ratio == null
                  ? (red.length === 0 ? 'No red days in this period.' : 'No green days in this period.')
                  : ratio >= 1.15
                    ? `A red day undoes about ${ratio.toFixed(1)} green days.`
                    : ratio <= 0.85
                      ? 'A red day costs less than a green day earns.'
                      : 'A red day costs about one green day.'}
              </p>
            </>
          )}
        </Col>
      </div>
    </>
  )
}
