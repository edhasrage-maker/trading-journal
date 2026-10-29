/**
 * Coach tag audit — how often the coach gets each trader's tags right
 * (founder, 2026-10-28; mockup https://claude.ai/artifact/3zaJp7LnBug1pjs1wwAX23).
 * Pure — src/lib/coach-tag-audit-server.ts reads and writes.
 *
 * Every tag the coach picks on a trade is a row in coach_tag_audit (one per
 * source: screenshot, notes, the 5m follow/fade read, an assisted fill). The
 * outcome is read against the trade's tags as they are NOW, so a tag taken off
 * anywhere — trade form, Deep Dive, weekly review, a month later — counts:
 *   not on the trade                          → taken off
 *   on it, with the trader's ✓                → kept
 *   on it, a suggestion the trader clicked    → kept
 *   on it, put on by the coach, no ✓ yet      → to check
 * A tag on a coach-tagged trade that no row names is one the coach missed
 * ("you added"). Rows with source 'before' are the tags the trader already had
 * when the coach first picked — never counted, they only keep those out of
 * "you added".
 *
 * Never counted (founder): rule mistake tags (review_json.auto_tags — the
 * trader's own rules), day types (they come from the day's own labels) and
 * emotions (the trader's call).
 *
 * Per trader by construction: rows are owner-only (RLS) and nothing here pools
 * across traders. Later steps (examples in the coach's prompt, a tag going on
 * by itself once it's usually right) read hitRates() / auditTrade().
 */
import { normalizeTagArray } from '@/lib/supabase/types'

export type CoachSource = 'screenshot' | 'notes' | 'structure' | 'assist' | 'before'
export const COACH_SOURCES: readonly CoachSource[] = ['screenshot', 'notes', 'structure', 'assist', 'before']

/** Tag groups the audit never counts. */
export const NEVER_AUDITED: ReadonlySet<string> = new Set(['day_type', 'emotions'])

export interface AuditRow {
  id: string
  trade_id: string
  category: string
  label: string
  source: CoachSource
  applied: boolean
  conf: 'H' | 'M' | 'L' | null
  reason: string | null
  proposed_at: string
  decision: 'kept' | 'removed' | null
}

export type Outcome = 'kept' | 'removed' | 'pending'

export interface AuditedTag {
  category: string
  label: string
  outcome: Outcome
  /** The coach put it on the trade (vs. a suggestion the trader clicked). */
  applied: boolean
  conf: 'H' | 'M' | 'L' | null
  reason: string | null
  /** Where the pick came from (the row with a reason, else the first). */
  source: CoachSource
}

export interface TradeAudit {
  tradeId: string
  tags: AuditedTag[]
  /** Tags the trader put on that the coach didn't pick. */
  added: Array<{ category: string; label: string }>
}

export interface TagHitRate {
  category: string
  label: string
  picked: number
  kept: number
  removed: number
  pending: number
  added: number
  /** kept ÷ (kept + taken off); null until one is decided. */
  right: number | null
}

export const auditKey = (category: string, label: string) => `${category}|${label}`

const labels = (tags: Record<string, unknown> | null | undefined, cat: string) => normalizeTagArray(tags?.[cat])

/** One trade's coach tags and their outcomes against its current tags. */
export function auditTrade(
  tradeId: string,
  rows: readonly AuditRow[],
  tagsJson: Record<string, unknown> | null | undefined,
  autoTags: readonly string[] = [],
): TradeAudit {
  const named = new Set<string>()
  const byKey = new Map<string, AuditRow[]>()
  for (const r of rows) {
    if (r.trade_id !== tradeId || NEVER_AUDITED.has(r.category)) continue
    const k = auditKey(r.category, r.label)
    named.add(k)
    if (r.source === 'before') continue
    if (r.category === 'mistakes' && autoTags.includes(r.label)) continue
    const list = byKey.get(k) ?? []
    list.push(r)
    byKey.set(k, list)
  }
  const tags: AuditedTag[] = []
  for (const list of byKey.values()) {
    const { category, label } = list[0]
    const onTrade = labels(tagsJson, category).includes(label)
    const applied = list.some(r => r.applied)
    const outcome: Outcome = !onTrade
      ? 'removed'
      : list.some(r => r.decision === 'kept') || !applied || list.some(r => r.decision === 'removed')
        ? 'kept' // ✓'d, a suggestion they clicked, or one they put back after taking it off
        : 'pending'
    const why = list.find(r => r.reason) ?? list[0]
    tags.push({ category, label, outcome, applied, conf: why.conf, reason: why.reason, source: why.source })
  }
  const added: TradeAudit['added'] = []
  if (tags.length) {
    for (const [category, value] of Object.entries(tagsJson ?? {})) {
      if (NEVER_AUDITED.has(category)) continue
      for (const label of normalizeTagArray(value)) {
        if (!label || named.has(auditKey(category, label))) continue
        if (category === 'mistakes' && autoTags.includes(label)) continue
        added.push({ category, label })
      }
    }
  }
  return { tradeId, tags, added }
}

/** Per-tag hit rate over a trader's audited trades, most-picked first. */
export function hitRates(trades: readonly TradeAudit[]): TagHitRate[] {
  const m = new Map<string, TagHitRate>()
  const row = (category: string, label: string) => {
    const k = auditKey(category, label)
    let r = m.get(k)
    if (!r) { r = { category, label, picked: 0, kept: 0, removed: 0, pending: 0, added: 0, right: null }; m.set(k, r) }
    return r
  }
  for (const t of trades) {
    for (const tag of t.tags) {
      const r = row(tag.category, tag.label)
      r.picked++
      if (tag.outcome === 'kept') r.kept++
      else if (tag.outcome === 'removed') r.removed++
      else r.pending++
    }
    for (const a of t.added) row(a.category, a.label).added++
  }
  const out = [...m.values()]
  for (const r of out) r.right = r.kept + r.removed ? r.kept / (r.kept + r.removed) : null
  return out.sort((a, b) => b.picked - a.picked || b.added - a.added || a.label.localeCompare(b.label))
}

/** Totals for the one-line summary: kept ÷ decided over every picked tag. */
export function hitTotals(rates: readonly TagHitRate[]): { picked: number; kept: number; removed: number; pending: number; right: number | null } {
  const t = rates.reduce((s, r) => ({ picked: s.picked + r.picked, kept: s.kept + r.kept, removed: s.removed + r.removed, pending: s.pending + r.pending }), { picked: 0, kept: 0, removed: 0, pending: 0 })
  return { ...t, right: t.kept + t.removed ? t.kept / (t.kept + t.removed) : null }
}
