'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useUiMode } from '@/lib/ui-mode'
import { GhostButton } from '@/components/ui/Section'
import { ScoreCluster } from '@/components/review/ReviewMonthHero'
import type { TapeScorePeriod } from '@/lib/tapescore'
import type { EvidenceBar } from '@/lib/prep-carryover'
import type { RecapVsRow } from '@/lib/period-recap'

export type { RecapVsRow }

/**
 * The Week / Month recap body (mockup: docs/tapescore-recap-mockup-r1.html,
 * artifact 216dda7b). The week debriefs, the month rules: a week is 10–20
 * trades, too thin for the finding engine, so its hero leads with what the
 * trader DID (rails, capture, the commitment) and only claims a finding when
 * the engine clears its bar; the month is finding-first at full strength.
 * Both refuse to manufacture a lesson — "no clear read" is a first-class state.
 *
 * Everything here is presentation: the server page computes the facts and the
 * copy so this component can't invent numbers.
 */

export type FindingState = 'edge' | 'leak' | 'held' | 'none'

export interface RecapFinding {
  state: FindingState
  headline: string
  sub: string
  next: string
  evidence: EvidenceBar[]
}

export interface RecapNumbers {
  pnl: number
  trades: number
  dayWins: number
  tradedDays: number
  capture: number | null
  mfeMae: number | null
  railsKept: number
  railsDays: number
}

export interface RecapCommitment {
  mode: 'protect' | 'correct'
  text: string
  /** Week view: one pip per committed day. Empty for the month view. */
  days: Array<{ label: string; state: 'held' | 'broke' | 'unresolved' }>
  summary: string
}

export interface RecapLedgerRow {
  href: string | null
  label: string
  sub: string | null
  read: string | null
  trades: number
  capture: number | null
  rails: string | null
  railsTone: 'pos' | 'neg' | null
  score: number | null
  pnl: number | null
  empty: boolean
}

/** Matches weekly_recap.ai_synthesis_json (weekly_grade intentionally ignored —
 *  the TapeScore is the grade; a second A–F vocabulary re-graded the same thing). */
export interface AiSynthesis {
  headline?: string
  themes?: string[]
  what_worked?: string[]
  what_didnt?: string[]
  focus_next_week?: string[]
  prior_week_overview?: string
  week_comparison?: string[]
  generated_at?: string
  model?: string
}

export interface RecapProps {
  scope: 'week' | 'month'
  /** POST body key for the analyze endpoint + PUT path segment for notes. */
  periodKey: string
  eyebrow: string
  pager: {
    prevHref: string
    prevLabel: string
    nextHref: string | null
    nextLabel: string | null
  }
  scorePeriod: TapeScorePeriod
  scoreLabel: string
  finding: RecapFinding
  numbers: RecapNumbers
  commitment: RecapCommitment | null
  ledger: { title: string; hint: string; rows: RecapLedgerRow[] }
  vs: { title: string; rows: RecapVsRow[] } | null
  initialSynthesis: AiSynthesis | null
  initialNotes: string
  /** True when the recap table hasn't been migrated yet — notes/synthesis
   *  still render but saving explains what's missing instead of failing mute. */
  migrationPending: boolean
}

const STATE_META: Record<FindingState, { label: string; cls: string }> = {
  edge: { label: 'Clear edge', cls: 'text-green-400' },
  leak: { label: 'Clear leak', cls: 'text-blue-400' },
  held: { label: 'Process held', cls: 'text-green-400' },
  none: { label: 'No clear read', cls: 'text-gray-500' },
}

const fmtUsd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(Math.round(v)).toLocaleString()}`
const pnlCls = (v: number | null) => (v == null ? 'text-gray-600' : v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400')

export default function PeriodRecapClient(p: RecapProps) {
  const { mode } = useUiMode()
  const s = STATE_META[p.finding.state]

  return (
    <div>
      {/* Eyebrow + period pager */}
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <span className="font-mono text-[11.5px] tracking-wide text-gray-500">{p.eyebrow}</span>
        <span className="flex gap-4 text-[12.5px]">
          <Link href={p.pager.prevHref} className="text-gray-400 hover:text-gray-100 transition-colors">
            ‹ {p.pager.prevLabel}
          </Link>
          {p.pager.nextHref ? (
            <Link href={p.pager.nextHref} className="text-gray-400 hover:text-gray-100 transition-colors">
              {p.pager.nextLabel} ›
            </Link>
          ) : (
            p.pager.nextLabel && <span className="text-gray-700">{p.pager.nextLabel} ›</span>
          )}
        </span>
      </div>

      {/* Hero — score cluster beside the finding (locked geometry) */}
      <div className="grid gap-8 items-start lg:grid-cols-[auto_1fr] mt-4">
        <div className="lg:border-r border-gray-800 lg:pr-8 pb-6 lg:pb-0 border-b lg:border-b-0 order-2 lg:order-1">
          <div className="flex items-center gap-1.5 mb-3">
            <span className="text-base font-bold tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
              TapeScore
            </span>
            <span className="text-[11px] text-gray-500">· {p.scoreLabel}</span>
          </div>
          <ScoreCluster period={p.scorePeriod} />
          {p.scorePeriod.score != null && (
            <p className="text-[11px] text-gray-600 mt-2.5 max-w-[30ch]">
              Across {p.scorePeriod.scoredDays} scored session{p.scorePeriod.scoredDays === 1 ? '' : 's'}
              {p.scorePeriod.scoredDays < 3 ? ' — thin; read it lightly.' : '.'}
            </p>
          )}
        </div>

        <div className="order-1 lg:order-2">
          <div className={cn('text-[12.5px] font-semibold mb-2.5 flex items-center gap-2', s.cls)}>
            {s.label}
            <span aria-hidden className="text-[11px] opacity-70">▸</span>
          </div>
          <h1
            className="text-[clamp(23px,3vw,30px)] font-bold leading-[1.1] tracking-[-0.025em] text-gray-100 text-balance max-w-[24ch]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {p.finding.headline}
          </h1>
          <p className="mt-3 text-[15px] text-gray-100 max-w-[56ch] leading-normal">{p.finding.sub}</p>
          <div className="mt-3.5 flex gap-3 items-baseline">
            <span className="text-[13px] font-bold text-blue-400 flex-shrink-0" style={{ fontFamily: 'var(--font-display)' }}>
              Do next
            </span>
            <span className="text-[15px] font-semibold text-gray-100 leading-snug max-w-[54ch]">{p.finding.next}</span>
          </div>

          {p.finding.evidence.length > 0 && (
            <div className="mt-5 pt-4 border-t border-gray-800 max-w-[560px]">
              <div className="flex items-baseline justify-between mb-2.5">
                <span className="text-[12.5px] text-gray-500">The evidence</span>
                <span className="text-xs text-gray-600">R per trade</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {p.finding.evidence.map(bar => (
                  <div key={bar.label} className="grid grid-cols-[150px_1fr_auto] gap-3 items-center">
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
      </div>

      {/* The numbers — inline ledger, no cards */}
      <div className="flex flex-wrap mt-7 pt-4 border-t border-gray-800 gap-y-4">
        <NumCell first label={`${p.scope === 'week' ? 'Week' : 'Month'} P&L`} value={fmtUsd(p.numbers.pnl)} valueCls={pnlCls(p.numbers.pnl)} />
        <NumCell label="Trades" value={String(p.numbers.trades)} />
        <NumCell label="Day wins" value={String(p.numbers.dayWins)} small={`of ${p.numbers.tradedDays}`} />
        <NumCell label="Profit captured" value={p.numbers.capture != null ? `${p.numbers.capture}%` : '—'} />
        {mode === 'pro' && (
          <NumCell label="MFE : MAE" value={p.numbers.mfeMae != null ? p.numbers.mfeMae.toFixed(1) : '—'} />
        )}
        {p.numbers.railsDays > 0 && (
          <NumCell label="Rails kept" value={String(p.numbers.railsKept)} small={`of ${p.numbers.railsDays} days`} />
        )}
      </div>

      {/* Commitment follow-through — the loop, reported */}
      {p.commitment && (
        <div className={cn('mt-7 border-l-2 pl-4 py-0.5', p.commitment.mode === 'protect' ? 'border-green-700' : 'border-blue-900')}>
          <div className="text-[12px] text-gray-500">Your commitment · from prep</div>
          <div className="text-[16px] font-bold text-gray-100 mt-1 tracking-[-0.01em]" style={{ fontFamily: 'var(--font-display)' }}>
            “{p.commitment.text}”
          </div>
          {p.commitment.days.length > 0 && (
            <div className="flex gap-3.5 mt-2.5">
              {p.commitment.days.map(d => (
                <span key={d.label} className="flex flex-col items-center gap-1 text-[10.5px] text-gray-600">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      d.state === 'held' ? 'bg-green-400' : d.state === 'broke' ? 'bg-red-400' : 'bg-gray-700',
                    )}
                    title={d.state === 'held' ? 'held' : d.state === 'broke' ? 'not held' : 'not resolved'}
                  />
                  {d.label}
                </span>
              ))}
            </div>
          )}
          <p className="text-[13px] text-gray-400 mt-2 max-w-[70ch]">{p.commitment.summary}</p>
        </div>
      )}

      {/* Sessions / weeks ledger */}
      <RecapSection title={p.ledger.title} hint={p.ledger.hint}>
        <div>
          <div className={cn('grid gap-3.5 pb-2 text-[12.5px] text-gray-500', GRID_COLS)}>
            <span>{p.scope === 'week' ? 'Day' : 'Week'}</span>
            <span className="hidden sm:block">Read</span>
            <span className="text-right">Trades</span>
            <span className="text-right hidden sm:block">Captured</span>
            <span className="text-right hidden md:block">Rails</span>
            <span className="text-right">TapeScore</span>
            <span className="text-right">Result</span>
          </div>
          {p.ledger.rows.map(row => {
            const inner = (
              <>
                <span className={cn('font-semibold', row.empty ? 'text-gray-600' : 'text-gray-100')}>
                  {row.label}
                  {row.sub && <span className="text-gray-500 font-normal ml-2 text-[12px]">{row.sub}</span>}
                </span>
                <span className="text-[13px] text-gray-400 truncate hidden sm:block">{row.read ?? (row.empty ? 'no trades' : '')}</span>
                <span className="text-right tabular-nums">{row.empty ? '—' : row.trades}</span>
                <span className="text-right tabular-nums hidden sm:block">{row.capture != null ? `${row.capture}%` : '—'}</span>
                <span className={cn('text-right text-[12.5px] hidden md:block', row.railsTone === 'pos' ? 'text-green-400' : row.railsTone === 'neg' ? 'text-red-400' : 'text-gray-600')}>
                  {row.rails ?? '—'}
                </span>
                <span className="text-right">
                  {row.score != null
                    ? <b className="tabular-nums text-[14px]" style={{ fontFamily: 'var(--font-display)' }}>{row.score}</b>
                    : <span className="text-gray-600">—</span>}
                </span>
                <span className={cn('text-right tabular-nums font-semibold', pnlCls(row.pnl))}>
                  {row.pnl != null ? fmtUsd(row.pnl) : '—'}
                </span>
              </>
            )
            const rowCls = cn(
              'grid gap-3.5 items-baseline py-2 border-t border-gray-800/70 text-[13.5px]',
              GRID_COLS,
              row.empty && 'opacity-60',
            )
            return row.href
              ? <Link key={row.label + (row.sub ?? '')} href={row.href} className={cn(rowCls, 'hover:bg-gray-900/50 transition-colors')}>{inner}</Link>
              : <div key={row.label + (row.sub ?? '')} className={rowCls}>{inner}</div>
          })}
        </div>
      </RecapSection>

      {/* Against the prior period */}
      {p.vs && (
        <RecapSection title={p.vs.title}>
          <div className="max-w-[620px]">
            <div className="grid grid-cols-[1fr_110px_110px_120px] gap-3.5 pb-2 text-[12.5px] text-gray-500">
              <span />
              <span className="text-right">Before</span>
              <span className="text-right">This {p.scope}</span>
              <span className="text-right">Change</span>
            </div>
            {p.vs.rows.map(r => (
              <div key={r.dim} className="grid grid-cols-[1fr_110px_110px_120px] gap-3.5 items-baseline py-1.5 border-t border-gray-800/70 text-[13.5px]">
                <span className="text-gray-400">{r.dim}</span>
                <span className="text-right tabular-nums text-gray-300">{r.prior}</span>
                <span className="text-right tabular-nums text-gray-100 font-semibold">{r.now}</span>
                <span className={cn('text-right text-[12.5px] tabular-nums', r.tone === 'pos' ? 'text-green-400' : r.tone === 'neg' ? 'text-red-400' : 'text-gray-500')}>
                  {r.delta}
                </span>
              </div>
            ))}
          </div>
        </RecapSection>
      )}

      <CoachRead
        scope={p.scope}
        periodKey={p.periodKey}
        initial={p.initialSynthesis}
        migrationPending={p.migrationPending}
      />

      <RecapNotes
        scope={p.scope}
        periodKey={p.periodKey}
        initial={p.initialNotes}
        migrationPending={p.migrationPending}
      />
    </div>
  )
}

const GRID_COLS = 'grid-cols-[minmax(110px,150px)_minmax(0,1fr)_58px_72px_80px_80px_88px] max-md:grid-cols-[minmax(110px,150px)_minmax(0,1fr)_58px_72px_80px_88px] max-sm:grid-cols-[minmax(90px,1fr)_58px_72px_88px]'

function NumCell({ label, value, small, valueCls, first }: { label: string; value: string; small?: string; valueCls?: string; first?: boolean }) {
  return (
    <div className={cn('px-6 border-l border-gray-800', first && 'pl-0 border-l-0')}>
      <div className="text-[12px] text-gray-500">{label}</div>
      <div className={cn('text-[20px] font-bold tabular-nums mt-0.5 text-gray-100', valueCls)} style={{ fontFamily: 'var(--font-display)' }}>
        {value}
        {small && <span className="text-[12.5px] text-gray-500 font-normal ml-1.5">{small}</span>}
      </div>
    </div>
  )
}

function RecapSection({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-8 pt-4 border-t border-gray-800">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="text-[15px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>{title}</span>
        {hint && <span className="text-[12px] text-gray-600">{hint}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  )
}

/** PT-formatted generated-at, mount-safe (rendered only client-side anyway). */
function generatedAtPT(iso: string | undefined): string | null {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }) + ' PT'
  } catch { return null }
}

function CoachRead({ scope, periodKey, initial, migrationPending }: {
  scope: 'week' | 'month'
  periodKey: string
  initial: AiSynthesis | null
  migrationPending: boolean
}) {
  const [synthesis, setSynthesis] = useState<AiSynthesis | null>(initial)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async () => {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(scope === 'week' ? '/api/analyze-week' : '/api/analyze-month', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope === 'week' ? { weekStart: periodKey } : { month: periodKey }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? `Generation failed (${res.status})`) } else { setSynthesis(data) }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error')
    } finally {
      setGenerating(false)
    }
  }

  const at = generatedAtPT(synthesis?.generated_at)
  const focusLabel = scope === 'week' ? 'Focus next week' : 'Focus next month'
  return (
    <RecapSection
      title="The coach’s read"
      action={<GhostButton onClick={generate} disabled={generating}>{generating ? 'Generating…' : synthesis ? 'Re-generate' : 'Generate'}</GhostButton>}
    >
      {synthesis ? (
        <div>
          <div className="text-[12px] text-gray-600 mb-3">
            <span className="text-gray-500 font-semibold">TapeScore suggested</span>
            {at && <> · generated {at}</>}
          </div>
          {synthesis.headline && <p className="text-[15px] font-semibold text-gray-100 max-w-[62ch] mb-3">{synthesis.headline}</p>}
          {synthesis.prior_week_overview && (
            <p className="text-[13px] text-gray-400 max-w-[70ch] mb-3">{synthesis.prior_week_overview}</p>
          )}
          {synthesis.week_comparison && synthesis.week_comparison.length > 0 && (
            <CoachGroup label={scope === 'week' ? 'Against last week' : 'Against last month'} items={synthesis.week_comparison} />
          )}
          {synthesis.themes && synthesis.themes.length > 0 && <CoachGroup label="Themes" items={synthesis.themes} />}
          {synthesis.what_worked && synthesis.what_worked.length > 0 && <CoachGroup label="What worked" items={synthesis.what_worked} />}
          {synthesis.what_didnt && synthesis.what_didnt.length > 0 && <CoachGroup label="What didn’t" items={synthesis.what_didnt} />}
          {synthesis.focus_next_week && synthesis.focus_next_week.length > 0 && <CoachGroup label={focusLabel} items={synthesis.focus_next_week} />}
        </div>
      ) : (
        <p className="text-[13px] text-gray-500 max-w-[62ch]">
          Generate a coach read of this {scope} — same data the chatbox sees, so the takeaways stay consistent.
          {migrationPending && ' (The recap table is missing on this database, so the read will not be cached between visits.)'}
        </p>
      )}
      {error && <p className="text-[13px] text-red-400 mt-2">{error}</p>}
    </RecapSection>
  )
}

function CoachGroup({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-3">
      <div className="text-[13px] font-bold text-gray-100 mb-1" style={{ fontFamily: 'var(--font-display)' }}>{label}</div>
      <ul>
        {items.map((item, i) => (
          <li key={i} className="text-[13.5px] text-gray-400 py-0.5 pl-4 relative max-w-[70ch] leading-snug">
            <span aria-hidden className="absolute left-0 text-gray-600">—</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

function RecapNotes({ scope, periodKey, initial, migrationPending }: {
  scope: 'week' | 'month'
  periodKey: string
  initial: string
  migrationPending: boolean
}) {
  const [notes, setNotes] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await fetch(scope === 'week' ? `/api/weekly-recap/${periodKey}` : `/api/monthly-recap/${periodKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes_md: notes }),
      })
      const data = await res.json()
      if (!res.ok) { setStatus(data.error ?? `Save failed (${res.status})`) } else { setDirty(false); setStatus('Saved') }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <RecapSection title="Your notes">
      <textarea
        value={notes}
        onChange={e => { setNotes(e.target.value); setDirty(true); setStatus(null) }}
        placeholder={scope === 'week'
          ? 'Your own takeaways for the week. What are you carrying into next week?'
          : 'Your own takeaways for the month. What are you carrying into next month?'}
        rows={5}
        className="w-full max-w-[720px] bg-gray-900 border border-gray-800 text-gray-200 rounded px-3.5 py-2.5 text-[13.5px] leading-relaxed placeholder-gray-600 focus:outline-none focus:border-gray-600 resize-vertical"
      />
      <div className="flex items-center gap-3 mt-2">
        <GhostButton onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save notes'}</GhostButton>
        {dirty && !status && <span className="text-[12px] text-gray-500">Unsaved</span>}
        {status && <span className={cn('text-[12px]', status === 'Saved' ? 'text-green-400' : 'text-red-400')}>{status}</span>}
        {migrationPending && <span className="text-[12px] text-gray-600">Recap table missing on this DB — apply the monthly_recap migration to save.</span>}
      </div>
    </RecapSection>
  )
}
