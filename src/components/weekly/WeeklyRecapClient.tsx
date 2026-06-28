'use client'

import { useState } from 'react'
import Link from 'next/link'
import { format, parseISO } from 'date-fns'
import {
  Brain, Save, Loader2, ChevronLeft, ChevronRight, Sparkles,
  CheckCircle2, AlertTriangle, Target, TrendingUp, TrendingDown, History,
} from 'lucide-react'
import { previousWeekStart, nextWeekStart } from '@/lib/week-dates'

export interface DayCard {
  date: string
  day_types: string[]
  eod_pnl: number | null
  trade_count: number
  wins: number
  win_rate?: number | null
  execution_composite: number | null
  process_verdict: 'Compliant' | 'Breach' | null
}

export interface AiSynthesis {
  headline?: string
  themes?: string[]
  what_worked?: string[]
  what_didnt?: string[]
  focus_next_week?: string[]
  /** 2-3 sentence recap of the PRIOR week's performance + the key shift into
   *  this week (week-over-week context). Empty when there was no prior-week data. */
  prior_week_overview?: string
  weekly_grade?: 'A' | 'B' | 'C' | 'D' | 'F'
  grade_reasoning?: string
  generated_at?: string
  model?: string
}

export interface WeeklyRecapInitial {
  ai_synthesis_json: AiSynthesis | null
  notes_md: string
  generated_at: string | null
}

interface Props {
  weekStart: string
  weekLabelText: string
  dayCards: DayCard[]
  initialRecap: WeeklyRecapInitial
}

export default function WeeklyRecapClient({ weekStart, weekLabelText, dayCards, initialRecap }: Props) {
  const [synthesis, setSynthesis] = useState<AiSynthesis | null>(initialRecap.ai_synthesis_json)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState(initialRecap.notes_md)
  const [notesDirty, setNotesDirty] = useState(false)
  const [savingNotes, setSavingNotes] = useState(false)
  const [notesToast, setNotesToast] = useState<string | null>(null)

  const totalPnl = dayCards.reduce((s, c) => s + (c.eod_pnl ?? 0), 0)
  const tradesTotal = dayCards.reduce((s, c) => s + c.trade_count, 0)
  const winsTotal = dayCards.reduce((s, c) => s + c.wins, 0)
  const lossesTotal = dayCards.reduce((s, c) => {
    if (c.win_rate == null) return s
    const tradesWithPnl = Math.round(c.trade_count * (c.wins > 0 ? 1 : 1))  // dayCards.wins is already pnl>0 count
    return s + Math.max(0, tradesWithPnl - c.wins)
  }, 0)
  const wrTotal = (winsTotal + lossesTotal) > 0 ? Math.round((winsTotal / (winsTotal + lossesTotal)) * 100) : null
  const compliantDays = dayCards.filter(c => c.process_verdict === 'Compliant').length
  const daysWithVerdict = dayCards.filter(c => c.process_verdict != null).length

  const generate = async () => {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/analyze-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? `Generation failed (${res.status})`)
        return
      }
      setSynthesis(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error')
    } finally {
      setGenerating(false)
    }
  }

  const saveNotes = async () => {
    setSavingNotes(true)
    setError(null)
    try {
      const res = await fetch(`/api/weekly-recap/${weekStart}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes_md: notes }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? `Save failed (${res.status})`)
        return
      }
      setNotesDirty(false)
      setNotesToast('Notes saved')
      setTimeout(() => setNotesToast(null), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error')
    } finally {
      setSavingNotes(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Weekly Recap</h1>
          <p className="text-gray-400 text-sm mt-1">{weekLabelText}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/weekly/${previousWeekStart(weekStart)}`}
            className="text-gray-400 hover:text-white transition-colors px-2 py-1 inline-flex items-center gap-1 text-sm"
          >
            <ChevronLeft className="w-4 h-4" /> Prev
          </Link>
          <Link
            href={`/weekly/${nextWeekStart(weekStart)}`}
            className="text-gray-400 hover:text-white transition-colors px-2 py-1 inline-flex items-center gap-1 text-sm"
          >
            Next <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* Week stats row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Total PnL" value={`${totalPnl >= 0 ? '+' : ''}$${Math.round(totalPnl).toLocaleString()}`} positive={totalPnl >= 0} />
        <StatCard label="Trades" value={tradesTotal.toString()} positive={null} />
        <StatCard label="Win Rate" value={wrTotal != null ? `${wrTotal}%` : '—'} positive={wrTotal != null && wrTotal >= 50} />
        <StatCard label="Compliance" value={daysWithVerdict > 0 ? `${compliantDays}/${daysWithVerdict}` : '—'} positive={daysWithVerdict > 0 && compliantDays >= daysWithVerdict - 1} hint="days Compliant" />
        <StatCard label="Trading Days" value={dayCards.filter(c => c.trade_count > 0).length.toString()} positive={null} hint="with trades" />
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-5 gap-3">
        {dayCards.map(card => <DayCardView key={card.date} card={card} />)}
      </div>

      {/* AI Synthesis */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Brain className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-white text-sm">Coach Synthesis</h2>
          {synthesis?.generated_at && (
            <span className="text-xs text-gray-500 ml-2">
              Generated {new Date(synthesis.generated_at).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="ml-auto bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-2"
          >
            {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {generating ? 'Generating…' : (synthesis ? 'Re-generate' : 'Generate synthesis')}
          </button>
        </div>

        {error && (
          <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {!synthesis && !generating && !error && (
          <p className="text-sm text-gray-500 italic">
            Click <strong>Generate synthesis</strong> to have the coach analyze this week. Uses the same data the chatbox sees so the takeaways stay consistent.
          </p>
        )}

        {synthesis && <SynthesisView s={synthesis} />}
      </div>

      {/* Your notes */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-purple-400" />
          <h2 className="font-semibold text-white text-sm">Your weekly notes</h2>
          {notesToast && (
            <span className="text-xs text-green-400 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> {notesToast}
            </span>
          )}
        </div>
        <textarea
          value={notes}
          onChange={e => { setNotes(e.target.value); setNotesDirty(true) }}
          placeholder="Your own takeaways for the week. What patterns are you noticing? What rule do you want to focus on next week?"
          rows={6}
          className="w-full bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:border-purple-500 resize-vertical"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveNotes}
            disabled={savingNotes || !notesDirty}
            className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-2"
          >
            {savingNotes ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {savingNotes ? 'Saving…' : 'Save notes'}
          </button>
          {notesDirty && <span className="text-xs text-amber-400">Unsaved</span>}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, positive, hint }: { label: string; value: string; positive: boolean | null; hint?: string }) {
  const color = positive == null ? 'text-gray-200' : positive ? 'text-green-400' : 'text-red-400'
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-xl font-bold font-mono ${color} mt-1`}>{value}</div>
      {hint && <div className="text-[10px] text-gray-600 mt-0.5">{hint}</div>}
    </div>
  )
}

function DayCardView({ card }: { card: DayCard }) {
  const pnlColor = card.eod_pnl == null ? 'text-gray-600' : card.eod_pnl > 0 ? 'text-green-400' : card.eod_pnl < 0 ? 'text-red-400' : 'text-gray-400'
  const verdictColor = card.process_verdict === 'Compliant' ? 'text-green-400 border-green-800/60 bg-green-950/30'
    : card.process_verdict === 'Breach' ? 'text-red-400 border-red-800/60 bg-red-950/30'
    : 'text-gray-500 border-gray-800 bg-gray-900'
  const date = parseISO(card.date)
  const isEmpty = card.trade_count === 0 && card.eod_pnl == null
  return (
    <Link href={`/eod/${card.date}`} className={`block bg-gray-900 border ${isEmpty ? 'border-gray-800/50 opacity-60' : 'border-gray-800 hover:border-gray-700'} rounded-xl p-3 transition-colors`}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{format(date, 'EEE')}</div>
      <div className="text-sm font-medium text-white">{format(date, 'MMM d')}</div>
      {card.day_types.length > 0 && (
        <div className="mt-1 text-[10px] text-gray-400 truncate" title={card.day_types.join(', ')}>{card.day_types.join(', ')}</div>
      )}
      <div className={`mt-2 text-base font-bold font-mono ${pnlColor}`}>
        {card.eod_pnl == null ? '—' : `${card.eod_pnl >= 0 ? '+' : ''}$${Math.round(card.eod_pnl).toLocaleString()}`}
      </div>
      <div className="text-[11px] text-gray-500 mt-1">{card.trade_count} {card.trade_count === 1 ? 'trade' : 'trades'} · WR {card.win_rate ?? '—'}%</div>
      <div className="flex items-center gap-1 mt-2">
        {card.execution_composite != null && (
          <span className="text-[10px] font-mono text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">
            Exec {Math.round(card.execution_composite * 100)}%
          </span>
        )}
        {card.process_verdict && (
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${verdictColor}`}>
            {card.process_verdict}
          </span>
        )}
      </div>
    </Link>
  )
}

function SynthesisView({ s }: { s: AiSynthesis }) {
  const gradeColor = s.weekly_grade === 'A' ? 'bg-green-600 text-white'
    : s.weekly_grade === 'B' ? 'bg-emerald-600 text-white'
    : s.weekly_grade === 'C' ? 'bg-yellow-600 text-white'
    : s.weekly_grade === 'D' ? 'bg-orange-600 text-white'
    : s.weekly_grade === 'F' ? 'bg-red-600 text-white'
    : 'bg-gray-700 text-gray-300'
  return (
    <div className="space-y-4">
      {(s.headline || s.weekly_grade) && (
        <div className="flex items-center gap-3">
          {s.weekly_grade && (
            <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-2xl font-bold ${gradeColor}`}>
              {s.weekly_grade}
            </div>
          )}
          <div className="flex-1">
            {s.headline && <p className="text-sm font-semibold text-white leading-snug">{s.headline}</p>}
            {s.grade_reasoning && <p className="text-xs text-gray-400 mt-1">{s.grade_reasoning}</p>}
          </div>
        </div>
      )}

      {s.prior_week_overview && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <History className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Last week</span>
          </div>
          <p className="text-xs text-gray-300 leading-snug">{s.prior_week_overview}</p>
        </div>
      )}

      {s.themes && s.themes.length > 0 && (
        <Section icon={<Sparkles className="w-3.5 h-3.5 text-blue-400" />} label="Themes" items={s.themes} bulletColor="text-blue-400" />
      )}
      {s.what_worked && s.what_worked.length > 0 && (
        <Section icon={<TrendingUp className="w-3.5 h-3.5 text-green-400" />} label="What worked" items={s.what_worked} bulletColor="text-green-400" />
      )}
      {s.what_didnt && s.what_didnt.length > 0 && (
        <Section icon={<TrendingDown className="w-3.5 h-3.5 text-red-400" />} label="What didn't" items={s.what_didnt} bulletColor="text-red-400" />
      )}
      {s.focus_next_week && s.focus_next_week.length > 0 && (
        <Section icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-400" />} label="Focus next week" items={s.focus_next_week} bulletColor="text-amber-400" />
      )}
    </div>
  )
}

function Section({ icon, label, items, bulletColor }: { icon: React.ReactNode; label: string; items: string[]; bulletColor: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        {icon}
        <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">{label}</span>
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-gray-200 flex gap-2">
            <span className={`${bulletColor} mt-0.5`}>▸</span>
            <span className="leading-snug">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
