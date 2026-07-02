/**
 * Coach Score — a per-trade execution grade (0–10) from the EOD 9-criterion
 * rubric, computed DETERMINISTICALLY from the trade's tags + geometry so it
 * shows live and free the moment a trade is tagged. Criteria that need judgment
 * (or a missing tag) come back `unknown`; the "Coach Score" AI button resolves
 * those, and applyAiResolutions() folds the answers back in.
 *
 * Rubric parity: mirrors src/lib/eod-prompt.ts §"Execution Parameters —
 * 9-criterion per-trade checklist" so a trade's live Coach Score lines up with
 * the EOD Execution score. `na` criteria are skipped in the denominator (same
 * as the EOD rubric); `unknown` is likewise excluded until the AI resolves it.
 */

export interface GradableTrade {
  entry_price: number | null
  stop_price: number | null
  tp1_price: number | null
  direction: 'long' | 'short' | null
  quantity: number | null
  entry_atr_1m?: number | null
  tags_json?: {
    setups?: string[]
    confluences?: string[]
    order_flow?: string[]
    entry_model?: string[]
    trade_management?: string[]
    mistakes?: string[]
    emotions?: string[]
  } | null
}

export type CriterionStatus = 'pass' | 'fail' | 'na' | 'unknown'

export interface Criterion {
  key: string
  label: string
  status: CriterionStatus
  reason?: string
  /** 'auto' = deterministic; 'ai' = resolved by the Coach Score AI pass. */
  source: 'auto' | 'ai'
}

export interface CoachScore {
  score: number | null   // 0–10, null when no criterion resolved to pass/fail
  passes: number
  fails: number
  total: number          // passes + fails (na + unknown excluded)
  unknownCount: number   // criteria the AI could resolve
  criteria: Criterion[]
}

const arr = (v?: string[]): string[] => (Array.isArray(v) ? v : [])
const lc = (s: string) => s.toLowerCase()

export function summarizeCoachScore(criteria: Criterion[]): CoachScore {
  const passes = criteria.filter(c => c.status === 'pass').length
  const fails = criteria.filter(c => c.status === 'fail').length
  const total = passes + fails
  return {
    score: total > 0 ? Math.round((passes / total) * 10) : null,
    passes, fails, total,
    unknownCount: criteria.filter(c => c.status === 'unknown').length,
    criteria,
  }
}

/**
 * Deterministic Coach Score. `setupLibrary` (lowercased curated setup labels)
 * lets criterion 1 verify the setup is a real playbook entry; omit it to just
 * require a setup tag.
 */
export function computeCoachScore(t: GradableTrade, opts?: { setupLibrary?: Set<string> }): CoachScore {
  const tj = t.tags_json ?? {}
  const setups = arr(tj.setups)
  const confluences = arr(tj.confluences)
  const orderFlow = arr(tj.order_flow)
  const entryModel = arr(tj.entry_model)
  const mistakes = arr(tj.mistakes)
  const emotions = arr(tj.emotions)
  const c: Criterion[] = []

  // 1. setup_in_playbook — a curated setup tag is present.
  if (setups.length === 0) {
    c.push({ key: 'setup_in_playbook', label: 'Setup in playbook', status: 'na', source: 'auto', reason: 'No setup tagged' })
  } else {
    const inLib = !opts?.setupLibrary || setups.some(s => opts.setupLibrary!.has(lc(s)))
    c.push({ key: 'setup_in_playbook', label: 'Setup in playbook', status: inLib ? 'pass' : 'fail', source: 'auto', reason: inLib ? undefined : 'Setup not in library' })
  }

  // 2. stop_in_atr_band — |entry−stop| ÷ entry ATR-10 within [0.5, 1.5]
  //    (1.25 upper for size-ups > 5 lots). N/A without an entry ATR (e.g. GBX).
  {
    const e = t.entry_price, s = t.stop_price, atr = t.entry_atr_1m
    if (e == null || s == null || atr == null || atr <= 0) {
      c.push({ key: 'stop_in_atr_band', label: 'Stop 0.5–1.5× ATR', status: 'na', source: 'auto', reason: atr == null ? 'No entry ATR' : 'Missing stop/entry' })
    } else {
      const mult = Math.abs(e - s) / atr
      const upper = (t.quantity ?? 0) > 5 ? 1.25 : 1.5
      const ok = mult >= 0.5 && mult <= upper
      c.push({ key: 'stop_in_atr_band', label: 'Stop 0.5–1.5× ATR', status: ok ? 'pass' : 'fail', source: 'auto', reason: `${mult.toFixed(2)}× ATR` })
    }
  }

  // 3. tp1_at_2r_or_reasoned — planned TP1 ÷ planned stop ≥ 2R. Below 2R needs a
  //    logged reason (judgment) → unknown for the AI to check the notes.
  {
    const e = t.entry_price, s = t.stop_price, tp = t.tp1_price
    if (e == null || s == null || tp == null || Math.abs(e - s) === 0) {
      c.push({ key: 'tp1_at_2r', label: 'TP1 ≥ 2R', status: 'na', source: 'auto', reason: 'Missing TP1/stop' })
    } else {
      const r = Math.abs(tp - e) / Math.abs(e - s)
      c.push(r >= 2
        ? { key: 'tp1_at_2r', label: 'TP1 ≥ 2R', status: 'pass', source: 'auto', reason: `${r.toFixed(1)}R` }
        : { key: 'tp1_at_2r', label: 'TP1 ≥ 2R', status: 'unknown', source: 'auto', reason: `${r.toFixed(1)}R — needs a logged reason` })
    }
  }

  // 4. clear_area_of_interest — a confluence tag anchors the entry to a level.
  //    None tagged → unknown (AI reads notes/chart for a mid-range vs level entry).
  c.push(confluences.length > 0
    ? { key: 'clear_aoi', label: 'Clear area of interest', status: 'pass', source: 'auto' }
    : { key: 'clear_aoi', label: 'Clear area of interest', status: 'unknown', source: 'auto', reason: 'No confluence tagged' })

  // 5. two_thirds_orderflow — ONLY gates the size-up (> 5 lots): ≥2/3 OF reads.
  //    ≤5 lots is N/A (never a fail — see feedback_2of3_orderflow_is_sizing_gate).
  {
    const qty = t.quantity ?? 0
    if (qty > 5) {
      c.push({ key: 'two_thirds_of', label: '2/3 order flow (size-up)', status: orderFlow.length >= 2 ? 'pass' : 'fail', source: 'auto', reason: `${orderFlow.length}/3 OF` })
    } else {
      c.push({ key: 'two_thirds_of', label: '2/3 order flow (size-up)', status: 'na', source: 'auto', reason: '≤5 lots — N/A' })
    }
  }

  // 6. break_of_cluster_or_bubble_entry — trust the entry_model / OF tag.
  {
    const has = [...entryModel, ...orderFlow].some(m => /break.*(cluster|bubble)/i.test(m))
    c.push(has
      ? { key: 'break_of_cluster', label: 'Break of cluster/bubble', status: 'pass', source: 'auto' }
      : { key: 'break_of_cluster', label: 'Break of cluster/bubble', status: 'unknown', source: 'auto', reason: 'No break-of-cluster tag' })
  }

  // 7. chart_not_emotion_management — was the exit a technical read or a PnL-
  //    anchored emotional one? Pure judgment on the notes → always AI.
  c.push({ key: 'chart_not_emotion', label: 'Chart-not-emotion exit', status: 'unknown', source: 'auto', reason: 'Needs read of exit reasoning' })

  // 8. no_mistakes_tagged.
  c.push({ key: 'no_mistakes', label: 'No mistakes tagged', status: mistakes.length === 0 ? 'pass' : 'fail', source: 'auto', reason: mistakes.length ? mistakes.join(', ') : undefined })

  // 9. stable_emotion — emotions includes "Stable" (Compromised / MAXRAGE fail).
  if (emotions.length === 0) {
    c.push({ key: 'stable_emotion', label: 'Stable emotion', status: 'unknown', source: 'auto', reason: 'No emotion tagged' })
  } else {
    const stable = emotions.some(e => lc(e) === 'stable')
    c.push({ key: 'stable_emotion', label: 'Stable emotion', status: stable ? 'pass' : 'fail', source: 'auto', reason: stable ? undefined : emotions.join(', ') })
  }

  return summarizeCoachScore(c)
}

/** Fold AI-resolved criteria (from the Coach Score button) back into a base
 *  score. `resolutions` maps criterion key → {status, reason}; only `unknown`
 *  criteria are overwritten, and they're marked source:'ai'. */
export function applyAiResolutions(
  base: CoachScore,
  resolutions: Record<string, { status: 'pass' | 'fail' | 'na'; reason?: string }>,
): CoachScore {
  const merged = base.criteria.map(cr => {
    if (cr.status !== 'unknown') return cr
    const r = resolutions[cr.key]
    if (!r) return cr
    return { ...cr, status: r.status, reason: r.reason ?? cr.reason, source: 'ai' as const }
  })
  return summarizeCoachScore(merged)
}
