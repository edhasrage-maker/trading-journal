'use client'

import { cn } from '@/lib/utils'
import type { TapeScorePeriod } from '@/lib/tapescore'
import type { Carryover } from '@/lib/prep-carryover'

/**
 * The Dashboard hero (the locked dashboard, artifact cebe7c02).
 *
 * The month's FINDING and the TapeScore live TOGETHER at the top: finding on
 * the left (state eyebrow → quantified headline → evidence), the TapeScore
 * composition ring + decision quality on the right. The ring's three weighted
 * segments ARE the score's decomposition (Risk 50 / Entry 30 / Capture 20) —
 * a green ring beside a red P&L is the point: grade decisions, not money. The
 * finding refuses to manufacture itself; "no clear read" is a first-class state.
 */

const BAND_TEXT: Record<'high' | 'mid' | 'low', string> = {
  high: 'text-green-400',
  mid: 'text-yellow-400',
  low: 'text-red-400',
}

function bandOf(score: number): { word: string; hue: string; cls: 'high' | 'mid' | 'low' } {
  if (score >= 80) return { word: 'Excellent', hue: 'var(--color-pos)', cls: 'high' }
  if (score >= 70) return { word: 'Strong', hue: 'var(--color-pos)', cls: 'high' }
  if (score >= 55) return { word: 'Fair', hue: 'var(--color-warn)', cls: 'mid' }
  return { word: 'Needs work', hue: 'var(--color-neg)', cls: 'low' }
}

/** One SVG arc path from angle a0→a1 (degrees, 0 = 12 o'clock, clockwise). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pol = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
  }
  const [x0, y0] = pol(a0)
  const [x1, y1] = pol(a1)
  const large = a1 - a0 > 180 ? 1 : 0
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

/** The composition ring: one complete circle split into three WEIGHTED segments
 *  (50/30/20 of the circumference), each filled to its own sub-score over a
 *  faint track, with clear gaps. */
function CompositionRing({ score, subs, size = 132 }: {
  score: number
  subs: { risk: number; entry: number; capture: number }
  size?: number
}) {
  const b = bandOf(score)
  const cx = 66, cy = 66, r = 51, W = 9, GAP = 8
  const segs: Array<[number, number]> = [[0.5, subs.risk], [0.3, subs.entry], [0.2, subs.capture]]
  const usable = 360 - GAP * segs.length
  let a = 0
  const paths: Array<{ d: string; stroke: string; cap: 'butt' | 'round' }> = []
  for (const [wt, sub] of segs) {
    const len = usable * wt
    const start = a + GAP / 2
    paths.push({ d: arc(cx, cy, r, start, start + len), stroke: 'var(--color-surface-3)', cap: 'butt' })
    if (sub > 0) paths.push({ d: arc(cx, cy, r, start, start + len * (sub / 100)), stroke: b.hue, cap: 'round' })
    a = start + len + GAP / 2
  }
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 132 132">
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={W} strokeLinecap={p.cap} />
        ))}
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div className={cn('text-[34px] font-bold tabular-nums', BAND_TEXT[b.cls])} style={{ fontFamily: 'var(--font-display)' }}>
            {score}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">{b.word}</div>
        </div>
      </div>
    </div>
  )
}

/** The TapeScore, decomposed — the ring + decision-quality list. Renders
 *  nothing when no day in the period was scored (the stat cards still stand). */
function ScoreCluster({ period }: { period: TapeScorePeriod }) {
  if (period.score == null) return null
  const subs = { risk: period.risk ?? 0, entry: period.entry ?? 0, capture: period.capture ?? 0 }
  const comps = [
    { name: 'Safety rails kept', score: subs.risk, wt: '50% of score' },
    { name: 'Entry quality', score: subs.entry, wt: '30% of score' },
    { name: 'Exit discipline', score: subs.capture, wt: '20% of score' },
  ]
  return (
    <div>
      {/* Name the score — the ring reads "60 / Fair", and this says what 60 is. */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-base font-bold tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
          TapeScore
        </span>
        <span className="text-[11px] text-gray-500">· all time</span>
      </div>
      <div className="flex items-center gap-6 flex-wrap">
        <CompositionRing score={period.score} subs={subs} />
        <div className="min-w-[172px]">
          <div className="text-[12.5px] text-gray-500 mb-2">Decision quality</div>
          {comps.map((c, i) => (
            <div key={c.name} className={cn('py-2', i > 0 && 'border-t border-gray-800')}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13.5px] text-gray-100">{c.name}</span>
                <span className="text-[15px] font-bold tabular-nums text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
                  {c.score}
                </span>
              </div>
              <div className="text-[11px] text-gray-500">{c.wt}</div>
            </div>
          ))}
          {period.scoredDays > 0 && (
            <div className="text-[11px] text-gray-600 mt-2">Across {period.scoredDays} scored session{period.scoredDays === 1 ? '' : 's'}</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** The finding copy — measured facts, never a causal story; honest "no read". */
function findingCopy(carryover: Carryover | null, tradeCount: number, monthLabel: string) {
  const state = carryover == null ? 'none' : carryover.mode === 'protect' ? 'edge' : 'leak'
  return {
    eyebrow: `${monthLabel} · ${tradeCount} trade${tradeCount === 1 ? '' : 's'}`,
    fstate: state === 'edge' ? 'Clear edge' : state === 'leak' ? 'Clear leak' : 'No clear read',
    fstateCls: state === 'edge' ? 'text-green-400' : state === 'leak' ? 'text-blue-400' : 'text-gray-500',
    headline: carryover ? `${carryover.finding}.` : 'Quiet month. Nothing separated itself.',
    sub: carryover
      ? `${carryover.metric}.`
      : 'No setup family or behaviour stood out this month — your numbers sit inside your normal range.',
    next: carryover?.today ?? 'No change to force — keep taking your A setups and let the sample build.',
  }
}

/**
 * The Dashboard hero — the month's finding and the TapeScore, together. Finding
 * on the left, the composition ring + decision quality on the right, evidence
 * across the bottom.
 */
export function DashboardHero({
  period,
  carryover,
  tradeCount,
  monthLabel,
}: {
  period: TapeScorePeriod
  carryover: Carryover | null
  tradeCount: number
  /** e.g. "July". */
  monthLabel: string
}) {
  const c = findingCopy(carryover, tradeCount, monthLabel)
  return (
    <div>
      <div className={cn('grid gap-8 items-start', period.score != null && 'lg:grid-cols-[auto_1fr]')}>
        {/* TapeScore — the score, named and decomposed (left) */}
        {period.score != null && (
          <div className="lg:border-r border-gray-800 lg:pr-8 pb-6 lg:pb-0 border-b lg:border-b-0">
            <ScoreCluster period={period} />
          </div>
        )}

        {/* Finding — this month's read (right) */}
        <div className={cn(period.score != null && 'lg:pl-1')}>
          <div className="font-mono text-[11.5px] tracking-wide text-gray-500 mb-2.5">This month · {c.eyebrow}</div>
          <div className={cn('text-[12.5px] font-semibold mb-2.5 flex items-center gap-2', c.fstateCls)}>
            {c.fstate}
            <span aria-hidden className="text-[11px] opacity-70">▸</span>
          </div>
          <h1
            className="text-[clamp(24px,3.2vw,32px)] font-bold leading-[1.08] tracking-[-0.025em] text-gray-100 text-balance max-w-[22ch]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {c.headline}
          </h1>
          <p className="mt-3.5 text-[15px] text-gray-100 max-w-[52ch] leading-normal">{c.sub}</p>
          <div className="mt-4 flex gap-3 items-baseline">
            <span className="text-[13px] font-bold text-blue-400 flex-shrink-0" style={{ fontFamily: 'var(--font-display)' }}>
              Next month
            </span>
            <span className="text-[15px] font-semibold text-gray-100 leading-snug max-w-[52ch]">{c.next}</span>
          </div>
        </div>
      </div>

      {/* Evidence — R per trade, across the bottom */}
      {carryover && carryover.evidence.length > 0 && (
        <div className="mt-7 pt-5 border-t border-gray-800">
          <div className="flex items-baseline justify-between mb-3 max-w-[560px]">
            <span className="text-[12.5px] text-gray-500">The evidence</span>
            <span className="text-xs text-gray-600">R per trade</span>
          </div>
          <div className="flex flex-col gap-2.5 max-w-[560px]">
            {carryover.evidence.map(bar => (
              <div key={bar.label} className="grid grid-cols-[140px_1fr_auto] gap-3 items-center">
                <span className="text-[13px] text-gray-400 truncate">{bar.label}</span>
                <span className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${bar.pct}%`,
                      background: bar.tone === 'pos' ? 'var(--color-pos)' : bar.tone === 'neg' ? 'var(--color-neg)' : 'var(--color-accent-deep)',
                    }}
                  />
                </span>
                <span className={cn('text-[13px] font-semibold tabular-nums', bar.tone === 'pos' ? 'text-green-400' : bar.tone === 'neg' ? 'text-red-400' : 'text-gray-200')}>
                  {bar.value}
                  <span className="text-[11px] text-gray-500 ml-1.5 font-normal">n={bar.n}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
