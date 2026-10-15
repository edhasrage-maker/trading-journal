'use client'

/**
 * Settings → Trading Rules → Runner rules (founder-approved mockup,
 * docs/runner-rules-mockup.html, 2026-10-15).
 *
 * How the trader manages what is left after TP1, graded from their own fills
 * (src/lib/runner-rules.ts) and shown in the Recap's Runner column. With any
 * rule counting on a trade, these are that trade's Exit "Runner rules" part.
 * Saved into scoring_profile_json.runner_rules as they are changed (the profile
 * route merges top-level keys, so nothing else is touched). Under each
 * checkable rule: how runners since its start date did when it passed vs failed.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { todayPT } from '@/lib/pt-time'
import { shortDate, tallyGroupText } from '@/lib/entry-rules'
import {
  RUNNER_TYPES, RUNNER_TYPE_HINTS, RUNNER_TYPE_LABELS, newRunnerRule, readRunnerRules, runnerRuleTally,
  type RunnerRuleConfig, type RunnerRuleType, type RunnerTallyTrade,
} from '@/lib/runner-rules'
import { NumInput, TextInput, TimeInput, ruleField as field } from './RuleInputs'

const SAVE_DELAY_MS = 500

export default function RunnerRulesSetting() {
  const [rules, setRules] = useState<RunnerRuleConfig[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [trades, setTrades] = useState<RunnerTallyTrade[] | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/onboarding').then(r => r.json()).then(d => {
      if (!cancelled) setRules(readRunnerRules(d?.scoring_profile?.runner_rules))
    }).catch(() => { if (!cancelled) { setRules([]); setError('Could not load your runner rules.') } })
    return () => { cancelled = true }
  }, [])

  // Trades since the earliest start date, for the tally under each rule.
  const earliest = rules?.length ? rules.map(r => r.from).sort()[0] : null
  useEffect(() => {
    if (!earliest) return
    let cancelled = false
    void (async () => {
      const sb = createClient()
      const PAGE = 1000
      const out: RunnerTallyTrade[] = []
      for (let p = 0; ; p++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exits_json is untyped jsonb
        const { data, error: e } = await (sb as any).from('trades')
          .select('id, entry_time, direction, symbol, pnl, entry_price, tp1_price, exits_json, entry_atr_1m')
          .gte('entry_time', earliest)   // UTC midnight = the evening before in PT, so the whole first day is in
          .order('entry_time', { ascending: true }).order('id', { ascending: true })
          .range(p * PAGE, p * PAGE + PAGE - 1)
        if (e || !data) return   // no tally rather than a row of zeros
        out.push(...(data as RunnerTallyTrade[]))
        if (data.length < PAGE) break
      }
      if (!cancelled) setTrades(out)
    })()
    return () => { cancelled = true }
  }, [earliest])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  const save = (next: RunnerRuleConfig[]) => {
    setRules(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/onboarding', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scoring_profile: { runner_rules: next } }),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not save.')
        setError(null)
        // re-tag every trade the rules reach: a rule fail is a mistake tag (src/lib/rule-tags.ts)
        void fetch('/api/trades/rule-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {})
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save.')
      }
    }, SAVE_DELAY_MS)
  }
  // every change goes through the same reader the grading uses, so what is shown is what is graded
  const update = (id: string, patch: Partial<RunnerRuleConfig>) => rules && save(rules.map(r => (r.id === id ? readRunnerRules([{ ...r, ...patch }])[0] ?? r : r)))
  const remove = (id: string) => rules && save(rules.filter(r => r.id !== id))
  const add = (type: RunnerRuleType) => {
    if (!rules) return
    const used = new Set(rules.map(r => r.name))
    let k = rules.length + 1
    while (used.has(`T${k}`)) k++
    save([...rules, newRunnerRule(type, `T${k}`, todayPT(), crypto.randomUUID().slice(0, 8))])
    setMenuOpen(false)
  }

  return (
    <div className="mt-10 pt-6 border-t border-gray-800">
      <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1.5">Runner rules</p>
      <p className="text-xs text-gray-400 mb-3 max-w-2xl">
        For trades that took something at TP1 and kept a piece on. Graded from your fills: how much came off at TP1 and how
        the rest left. These become the Runner part of your Exit grade from each rule&apos;s start date.
      </p>
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
      {rules == null ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : (
        <div className="space-y-2.5">
          {rules.map(r => (
            <RunnerCard key={r.id} rule={r} trades={trades} onChange={patch => update(r.id, patch)} onRemove={() => remove(r.id)} />
          ))}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(o => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              className="text-[13px] text-blue-400 border border-gray-800 hover:border-blue-500 rounded-lg px-3 py-1.5"
            >
              + Add a runner rule
            </button>
            {menuOpen && (
              <div className="absolute left-0 top-full mt-1.5 z-30 w-[min(440px,calc(100vw-32px))] bg-gray-900 border border-gray-700 rounded-lg p-1.5 shadow-xl grid gap-0.5">
                {RUNNER_TYPES.map(t => (
                  <button key={t} type="button" onClick={() => add(t)} className="text-left px-2.5 py-2 rounded-md hover:bg-gray-800">
                    <span className="block text-sm text-gray-200">{RUNNER_TYPE_LABELS[t]}</span>
                    <span className="block text-xs text-gray-500">{RUNNER_TYPE_HINTS[t]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="text-xs text-gray-500 border-t border-gray-800/70 pt-2.5 space-y-1 max-w-3xl">
            <p>TP1 = the TP1 price logged on the trade. Fills within 30 seconds of each other count as one exit. The first exit at TP1 or better is the scale-out; whatever is still on after it is the runner.</p>
            <p>ATR = the 1-minute ATR(10) (Wilder) at entry, the one the TP2 study used. Trades that never took anything at TP1 are not judged here; how those ended is Profit kept and Stop respected.</p>
          </div>
        </div>
      )}
    </div>
  )
}

function RunnerCard({ rule: r, trades, onChange, onRemove }: {
  rule: RunnerRuleConfig
  trades: RunnerTallyTrade[] | null
  onChange: (patch: Partial<RunnerRuleConfig>) => void
  onRemove: () => void
}) {
  const checkable = r.type !== 'be_after_tp1'
  const tally = useMemo(() => (trades && checkable ? runnerRuleTally(r, trades) : null), [r, trades, checkable])
  const label = r.name.trim() || RUNNER_TYPE_LABELS[r.type]
  const n = (key: 'pct' | 'be_ticks' | 'target_atr' | 'target_tol', decimals: number, aria: string) => (
    // keyed by the saved value, so a value changed elsewhere (clamped, reloaded) re-seeds the box
    <NumInput key={`${key}:${r[key]}`} value={r[key] ?? 0} decimals={decimals} aria={`${label} ${aria}`} onCommit={v => onChange({ [key]: v } as Partial<RunnerRuleConfig>)} />
  )
  return (
    <div className={`border border-gray-800 rounded-lg px-3.5 py-3 space-y-2 ${checkable ? '' : 'border-dashed'} ${r.on ? '' : 'opacity-55'}`}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <button
          type="button" role="switch" aria-checked={r.on} aria-label={`${label} on`}
          onClick={() => onChange({ on: !r.on })}
          className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 shrink-0 ${r.on ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span className={`w-4 h-4 rounded-full bg-white transition-transform ${r.on ? 'translate-x-4' : ''}`} />
        </button>
        <TextInput key={r.name} value={r.name} aria="Rule name" onCommit={v => onChange({ name: v.slice(0, 24) })} />
        <span className="text-sm font-semibold text-gray-200 flex-1 min-w-0">{RUNNER_TYPE_LABELS[r.type]}</span>
        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          Counts from
          <input
            type="date" value={r.from} aria-label={`${label} counts from`}
            onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange({ from: e.target.value }) }}
            className={`${field} text-xs w-[132px]`}
          />
        </label>
        <button type="button" onClick={onRemove} title="Remove this rule" aria-label={`Remove ${label}`} className="text-gray-600 hover:text-red-400 text-base leading-none px-1">×</button>
      </div>
      <div className="md:pl-[46px] text-[13.5px] text-gray-200 leading-8">
        {r.type === 'scale_out' && <>Pass when at least {n('pct', 0, 'percent')}% of the position comes off at my TP1 price or better.</>}
        {r.type === 'runner_exit' && (
          <>
            Pass when what is left after TP1 exits only at breakeven (within {n('be_ticks', 0, 'breakeven ticks')} ticks of entry), the target
            ({n('target_atr', 1, 'target ATR multiple')}× ATR from entry, within {n('target_tol', 2, 'target tolerance')}× ATR), or still open at{' '}
            <TimeInput key={`close:${r.close}`} value={r.close ?? '13:00'} aria={`${label} close time`} onCommit={v => onChange({ close: v })} /> PT.
            Any other exit counts as closed by hand.
          </>
        )}
        {r.type === 'be_after_tp1' && <>Pass when the stop moves to breakeven only after TP1 fills, never before.</>}
      </div>
      {!checkable && (
        <p className="md:pl-[46px] text-xs text-amber-400">
          Can&apos;t be checked yet: your fills don&apos;t show when the stop moved. Every trade shows &ldquo;unknown&rdquo; here, which never counts for or against you.
        </p>
      )}
      {tally && (
        <p className="md:pl-[46px] text-[11.5px] text-gray-600 tabular-nums">
          Since {shortDate(tally.from)} · <b className="text-gray-400 font-semibold">pass</b> {tallyGroupText(tally.pass)}
          {' '}&nbsp;|&nbsp; <b className="text-gray-400 font-semibold">fail</b> {tallyGroupText(tally.fail, false)}
          {' '}&nbsp;|&nbsp; unknown {tally.unknown}
        </p>
      )}
    </div>
  )
}
