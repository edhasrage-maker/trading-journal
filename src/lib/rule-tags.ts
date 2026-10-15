/**
 * Rule fails become mistake tags (founder, 2026-10-15; mockup
 * docs/trade-grade-mockup.html). Pure — src/lib/rule-tags-server.ts applies it.
 *
 * Every entry or runner rule that FAILS and COUNTS on a trade (on, trade on or
 * after the rule's start date) puts its mistake tag on the trade —
 * ruleMistakeTag / runnerMistakeTag name it for what went wrong. Unknown never
 * tags. The app keeps the list of tags it added in review_json.auto_tags
 * (never in tags_json, whose keys are read as tag categories), so:
 *   - a tag the trader added themselves is never removed, even when it has the
 *     same name as a rule's tag — it simply isn't claimed
 *   - when a rule changes or is switched off, only the app's own tags go
 *   - an app tag dropped by an older copy of the trade being saved comes back:
 *     while the rule fails, its tag is on the trade (change the rule to change that)
 * The trader accepted the side effect: the checklist item "no mistakes tagged"
 * reads these tags too.
 */
import { evaluateRules, ruleMistakeTag, type EntryRuleConfig } from '@/lib/entry-rules'
import { evaluateRunnerRules, runnerMistakeTag, type RunnerRuleConfig, type RunnerTrade } from '@/lib/runner-rules'
import type { TradeEntryCtx } from '@/lib/supabase/types'

export type RuleTagTrade = RunnerTrade & { review_json?: { entry_ctx?: TradeEntryCtx | null } | null }

/** The mistake tags the trader's rules put on this trade, in rule order. */
export function ruleMistakeTagsFor(t: RuleTagTrade, entryRules: readonly EntryRuleConfig[], runnerRules: readonly RunnerRuleConfig[]): string[] {
  const out: string[] = []
  const add = (tag: string | null) => { if (tag && !out.includes(tag)) out.push(tag) }
  const er = entryRules.filter(r => r.on)
  if (er.length) {
    const res = evaluateRules(er, t.review_json?.entry_ctx ?? null, { direction: t.direction, symbol: t.symbol, entry_time: t.entry_time ?? null })
    res.forEach((r, i) => { if (r.counted && r.status === 'fail') add(ruleMistakeTag(er[i])) })
  }
  const rr = runnerRules.filter(r => r.on)
  const run = rr.length ? evaluateRunnerRules(rr, t) : null
  run?.forEach((r, i) => { if (r.counted && r.status === 'fail') add(runnerMistakeTag(rr[i])) })
  return out
}

/** Every mistake tag the trader's rules can put on a trade — the tag library entries the app keeps. */
export function allRuleMistakeTags(entryRules: readonly EntryRuleConfig[], runnerRules: readonly RunnerRuleConfig[]): string[] {
  const out: string[] = []
  for (const r of entryRules) if (r.on) { const tag = ruleMistakeTag(r); if (!out.includes(tag)) out.push(tag) }
  for (const r of runnerRules) if (r.on) { const tag = runnerMistakeTag(r); if (tag && !out.includes(tag)) out.push(tag) }
  return out
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : [])

/**
 * The trade's mistakes after the app's tags are brought up to date.
 *   prevAuto  the tags the app had added (review_json.auto_tags)
 *   next      what the rules say now (ruleMistakeTagsFor)
 * The trader's own tags (on the trade but never added by the app) are left as
 * they are and never claimed.
 */
export function mergeAutoMistakes(mistakesIn: unknown, prevAutoIn: unknown, next: readonly string[]): { mistakes: string[]; auto: string[]; changed: boolean } {
  const mistakes = arr(mistakesIn)
  const prevAuto = arr(prevAutoIn)
  const userOwned = new Set(mistakes.filter(m => !prevAuto.includes(m)))
  const auto = next.filter(tag => !userOwned.has(tag))
  const kept = mistakes.filter(m => userOwned.has(m) || auto.includes(m))
  const out = [...kept, ...auto.filter(tag => !kept.includes(tag))]
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  return { mistakes: out, auto, changed: !same(out, mistakes) || !same(auto, prevAuto) }
}
