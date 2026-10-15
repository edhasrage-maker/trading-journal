'use client'

/**
 * Settings → Trading Rules → Entry rules (founder-approved mockup,
 * docs/entry-rules-mockup.html, 2026-10-14).
 *
 * Ready-made rule types the trader switches on and sets numbers for; each is
 * graded on every trade from the tick tape (src/lib/entry-rules.ts) and shown
 * next to the Score in the Recap. Saved into scoring_profile_json.entry_rules
 * as they are changed (the profile route merges top-level keys, so this
 * touches nothing else). Under each rule: how trades since its start date did
 * when it passed vs failed.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { todayPT } from '@/lib/pt-time'
import {
  RULE_TYPES, RULE_TYPE_HINTS, RULE_TYPE_LABELS, newEntryRule, readEntryRules, ruleTally, shortDate, tallyGroupText,
  type EntryRuleConfig, type EntryRuleType, type TallyTrade, type TapeMode,
} from '@/lib/entry-rules'
import type { TradeEntryCtx } from '@/lib/supabase/types'
import { NumInput, TextInput, ruleField as field } from './RuleInputs'
const SAVE_DELAY_MS = 500

export default function EntryRulesSetting() {
  const [rules, setRules] = useState<EntryRuleConfig[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [trades, setTrades] = useState<TallyTrade[] | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/onboarding').then(r => r.json()).then(d => {
      if (!cancelled) setRules(readEntryRules(d?.scoring_profile?.entry_rules))
    }).catch(() => { if (!cancelled) { setRules([]); setError('Could not load your entry rules.') } })
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
      const out: TallyTrade[] = []
      for (let p = 0; ; p++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- review_json is newer than the generated types
        const { data, error: e } = await (sb as any).from('trades')
          .select('id, entry_time, direction, symbol, pnl, entry_ctx:review_json->entry_ctx')
          .gte('entry_time', earliest)   // UTC midnight = the evening before in PT, so the whole first day is in
          .order('entry_time', { ascending: true }).order('id', { ascending: true })
          .range(p * PAGE, p * PAGE + PAGE - 1)
        if (e || !data) return   // no tally rather than a row of zeros
        for (const t of data as { entry_time: string | null; direction: string | null; symbol: string | null; pnl: number | null; entry_ctx: TradeEntryCtx | null }[]) {
          out.push({ entry_time: t.entry_time, direction: t.direction, symbol: t.symbol, pnl: t.pnl, ctx: t.entry_ctx })
        }
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

  const save = (next: EntryRuleConfig[]) => {
    setRules(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/onboarding', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scoring_profile: { entry_rules: next } }),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not save.')
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save.')
      }
    }, SAVE_DELAY_MS)
  }
  // every change goes through the same reader the grading uses, so what is shown is what is graded
  const update = (id: string, patch: Partial<EntryRuleConfig>) => rules && save(rules.map(r => (r.id === id ? readEntryRules([{ ...r, ...patch }])[0] ?? r : r)))
  const remove = (id: string) => rules && save(rules.filter(r => r.id !== id))
  const add = (type: EntryRuleType) => {
    if (!rules) return
    const used = new Set(rules.map(r => r.name))
    let k = rules.length + 1
    while (used.has(`R${k}`)) k++
    const id = crypto.randomUUID().slice(0, 8)
    save([...rules, newEntryRule(type, `R${k}`, todayPT(), id)])
    setMenuOpen(false)
  }

  return (
    <div className="mt-10 pt-6 border-t border-gray-800">
      <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1.5">Entry rules</p>
      <p className="text-xs text-gray-400 mb-3 max-w-2xl">
        Checked on every trade from the tick tape, using only what had printed before your fill. Each check comes out pass,
        fail or unknown, with the reason. Your Entry grade counts them from each rule&apos;s start date.
      </p>
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
      {rules == null ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : (
        <div className="space-y-2.5">
          {rules.map(r => (
            <RuleCard key={r.id} rule={r} trades={trades} onChange={patch => update(r.id, patch)} onRemove={() => remove(r.id)} />
          ))}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(o => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              className="text-[13px] text-blue-400 border border-gray-800 hover:border-blue-500 rounded-lg px-3 py-1.5"
            >
              + Add an entry rule
            </button>
            {menuOpen && (
              <div className="absolute left-0 top-full mt-1.5 z-30 w-[min(440px,calc(100vw-32px))] bg-gray-900 border border-gray-700 rounded-lg p-1.5 shadow-xl grid gap-0.5">
                {RULE_TYPES.map(t => (
                  <button key={t} type="button" onClick={() => add(t)} className="text-left px-2.5 py-2 rounded-md hover:bg-gray-800">
                    <span className="block text-sm text-gray-200">{RULE_TYPE_LABELS[t]}</span>
                    <span className="block text-xs text-gray-500">{RULE_TYPE_HINTS[t]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="text-xs text-gray-500 border-t border-gray-800/70 pt-2.5 space-y-1 max-w-3xl">
            <p>Candles are regular 1-minute candles unless the rule says Heiken Ashi. “Closed” means the candle finished before your fill; the minute you got in is never counted as a candle. A flat candle (close = open) is not against you.</p>
            <p>ATR = the simple average true range of the 10 one-minute candles before the one being judged. Tape Reader = ask share of everything traded in the 480 seconds before your fill, minus 50, as your research measured it. Your chart&apos;s study counts clock minutes instead; the two differ on about 1 trade in 11.</p>
            <p>Unknown = the tape can&apos;t show it (no tick data for that time or instrument). Unknown never counts for or against you.</p>
          </div>
        </div>
      )}
    </div>
  )
}

function RuleCard({ rule: r, trades, onChange, onRemove }: {
  rule: EntryRuleConfig
  trades: TallyTrade[] | null
  onChange: (patch: Partial<EntryRuleConfig>) => void
  onRemove: () => void
}) {
  const tally = useMemo(() => (trades ? ruleTally(r, trades) : null), [r, trades])
  const label = r.name.trim() || RULE_TYPE_LABELS[r.type]
  const n = (key: 'n' | 'atr' | 'body' | 'vol' | 'delta' | 'nq' | 'es' | 'press_nq' | 'press_es', decimals: number, aria: string) => (
    // keyed by the saved value, so a value changed elsewhere (clamped, reloaded) re-seeds the box
    <NumInput key={`${key}:${r[key]}`} value={r[key] ?? 0} decimals={decimals} aria={`${label} ${aria}`} onCommit={v => onChange({ [key]: v } as Partial<EntryRuleConfig>)} />
  )
  return (
    <div className={`border border-gray-800 rounded-lg px-3.5 py-3 space-y-2 ${r.on ? '' : 'opacity-55'}`}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <button
          type="button" role="switch" aria-checked={r.on} aria-label={`${label} on`}
          onClick={() => onChange({ on: !r.on })}
          className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 shrink-0 ${r.on ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span className={`w-4 h-4 rounded-full bg-white transition-transform ${r.on ? 'translate-x-4' : ''}`} />
        </button>
        <TextInput key={r.name} value={r.name} aria="Rule name" onCommit={v => onChange({ name: v.slice(0, 24) })} />
        <span className="text-sm font-semibold text-gray-200 flex-1 min-w-0">{RULE_TYPE_LABELS[r.type]}</span>
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
        {r.type === 'candles_against' && <>Fail when the last {n('n', 0, 'candles')} closed 1-minute candles all closed against me.</>}
        {r.type === 'last_candle' && <>Pass when the last closed 1-minute candle closed my way or flat.</>}
        {r.type === 'large_against' && <>Fail when one of the last {n('n', 0, 'candles')} closed candles went against me with a range of at least {n('atr', 1, 'ATR multiple')}× ATR and a body of at least {n('body', 0, 'body percent')}% of its range.</>}
        {r.type === 'fade_spike' && <>Fail when I enter against a large candle (range {n('atr', 1, 'ATR multiple')}× ATR, body {n('body', 0, 'body percent')}%) or a delta spike (volume {n('vol', 1, 'volume multiple')}× and delta {n('delta', 1, 'delta multiple')}× the median of the 10 minutes before it) from the last {n('n', 0, 'minutes')} minutes.</>}
        {r.type === 'ha_run' && <>Fail when the last {n('n', 0, 'candles')} completed 1-minute Heiken Ashi candles were already my colour.</>}
        {r.type === 'tape' && (
          <>
            Pass when the Tape Reader is{' '}
            <select
              value={r.mode ?? 'band'} aria-label={`${label} tape mode`}
              onChange={e => onChange({ mode: e.target.value as TapeMode })}
              className={`${field} max-w-[11.5rem]`}
            >
              <option value="band">inside the band ±</option>
              <option value="not_against">not against me at −</option>
              <option value="pressure">not against me past the pressure line</option>
            </select>{' '}
            {r.mode === 'pressure'
              ? <>{n('press_nq', 1, 'pressure line NQ')} on NQ, {n('press_es', 1, 'pressure line ES')} on ES.</>
              : <>{n('nq', 1, 'NQ')} on NQ, {n('es', 1, 'ES')} on ES.</>}
            {(r.mode ?? 'band') === 'band' && (
              <span className="text-gray-500 text-[11px]"> Pressure line for the reason text: {n('press_nq', 1, 'pressure line NQ')} NQ, {n('press_es', 1, 'pressure line ES')} ES.</span>
            )}
          </>
        )}
      </div>
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
