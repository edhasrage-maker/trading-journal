/**
 * Coach tag audit — reads and writes (src/lib/coach-tag-audit.ts says what the
 * rows mean). Server only, through the CALLER's session client: RLS confines
 * every read and write to the trader's own rows and trades.
 *
 * Writes to a trade's tags (✕ in the weekly check, Undo) are read-merge: the
 * row is read again just before the write and only that one tag changes.
 * Until the coach_tag_audit migration has run, reads come back empty and
 * writes report it — nothing else breaks.
 */
import { normalizeTagArray } from '@/lib/supabase/types'
import { auditKey, auditTrade, COACH_SOURCES, NEVER_AUDITED, type AuditRow, type CoachSource, type TradeAudit } from '@/lib/coach-tag-audit'
import { TRADE_TAG_CATS } from '@/lib/trade-tag-groups'
import type { CoachCheckChip, CoachCheckData, CoachCheckTrade } from '@/components/review/CoachTagCheck'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000
const CHUNK = 100
const ROW_COLS = 'id, trade_id, category, label, source, applied, conf, reason, proposed_at, decision'

export interface Pick { category: string; label: string; source: CoachSource; applied?: boolean; conf?: 'H' | 'M' | 'L' | null; reason?: string | null }

/** The migration hasn't run yet (Postgres 42P01 / PostgREST schema cache miss). */
export const tableMissing = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /coach_tag_audit/.test(e.message ?? ''))

async function rowsFor(supabase: AnyClient, tradeIds?: readonly string[]): Promise<AuditRow[]> {
  const out: AuditRow[] = []
  if (tradeIds) {
    for (let i = 0; i < tradeIds.length; i += CHUNK) {
      const { data, error } = await supabase.from('coach_tag_audit').select(ROW_COLS).in('trade_id', tradeIds.slice(i, i + CHUNK))
      if (error) { if (tableMissing(error)) return []; throw new Error(error.message) }
      out.push(...((data ?? []) as AuditRow[]))
    }
    return out
  }
  for (let p = 0; ; p++) {
    const { data, error } = await supabase.from('coach_tag_audit').select(ROW_COLS).order('proposed_at').order('id').range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { if (tableMissing(error)) return []; throw new Error(error.message) }
    out.push(...((data ?? []) as AuditRow[]))
    if ((data ?? []).length < PAGE) break
  }
  return out
}

type TradeTagsRow = { id: string; tags_json: Record<string, unknown> | null; review_json: { auto_tags?: unknown } | null }

async function tradesFor(supabase: AnyClient, ids: readonly string[]): Promise<TradeTagsRow[]> {
  const out: TradeTagsRow[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase.from('trades').select('id, tags_json, review_json').in('id', ids.slice(i, i + CHUNK))
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as TradeTagsRow[]))
  }
  return out
}

const autoOf = (t: TradeTagsRow) => normalizeTagArray(t.review_json?.auto_tags)

/**
 * The trader's audited trades (every trade the coach picked on, or just
 * `tradeIds`), each with its tags' outcomes read against its current tags.
 */
export async function loadTradeAudits(supabase: AnyClient, tradeIds?: readonly string[]): Promise<TradeAudit[]> {
  const rows = await rowsFor(supabase, tradeIds)
  const ids = [...new Set(rows.map(r => r.trade_id))]
  if (!ids.length) return []
  const trades = await tradesFor(supabase, ids)
  return trades.map(t => auditTrade(t.id, rows, t.tags_json, autoOf(t))).filter(a => a.tags.length > 0)
}

/** `category|label` of the tags the coach put on this trade (the "coach" mark), still on it. */
export async function coachAppliedKeys(supabase: AnyClient, tradeId: string): Promise<string[]> {
  const [a] = await loadTradeAudits(supabase, [tradeId])
  return (a?.tags ?? []).filter(t => t.applied && t.outcome !== 'removed').map(t => auditKey(t.category, t.label))
}

/**
 * Record what the coach picked on a trade. `before` = the trader's tags on the
 * trade when the coach first picked; they're stored only the first time a
 * trade gets picks, so a later save can't claim the coach's own tags as theirs.
 * Re-recording the same pick is a no-op.
 */
export async function recordPicks(supabase: AnyClient, tradeId: string, picks: readonly Pick[], before: Record<string, unknown> | null = null): Promise<{ recorded: number }> {
  const clean = picks.filter(p => p.category && p.label && !NEVER_AUDITED.has(p.category) && COACH_SOURCES.includes(p.source) && p.source !== 'before')
  if (!clean.length) return { recorded: 0 }
  const { data: existing, error: ee } = await supabase.from('coach_tag_audit').select('id').eq('trade_id', tradeId).neq('source', 'before').limit(1)
  if (ee) throw ee
  const now = new Date().toISOString()
  const rows: Record<string, unknown>[] = clean.map(p => ({
    trade_id: tradeId, category: p.category, label: p.label, source: p.source,
    applied: !!p.applied, conf: p.conf ?? null, reason: p.reason ?? null, proposed_at: now,
  }))
  if (!(existing ?? []).length && before) {
    const picked = new Set(clean.map(p => auditKey(p.category, p.label)))
    for (const [category, value] of Object.entries(before)) {
      if (NEVER_AUDITED.has(category)) continue
      for (const label of normalizeTagArray(value)) {
        if (label && !picked.has(auditKey(category, label))) rows.push({ trade_id: tradeId, category, label, source: 'before', applied: false, proposed_at: now })
      }
    }
  }
  const { error } = await supabase.from('coach_tag_audit').upsert(rows, { onConflict: 'trade_id,category,label,source', ignoreDuplicates: true })
  if (error) throw error
  return { recorded: clean.length }
}

async function pickRows(supabase: AnyClient, tradeId: string, keys: readonly string[]): Promise<AuditRow[]> {
  const { data, error } = await supabase.from('coach_tag_audit').select(ROW_COLS).eq('trade_id', tradeId).neq('source', 'before')
  if (error) throw error
  const want = new Set(keys)
  return ((data ?? []) as AuditRow[]).filter(r => want.has(auditKey(r.category, r.label)))
}

async function decide(supabase: AnyClient, ids: readonly string[], decision: 'kept' | 'removed' | null) {
  if (!ids.length) return
  const { error } = await supabase.from('coach_tag_audit')
    .update({ decision, decided_at: decision ? new Date().toISOString() : null })
    .in('id', ids)
  if (error) throw error
}

/** Put one tag on or take it off the trade — read-merge, only that tag changes. */
async function setTagOnTrade(supabase: AnyClient, tradeId: string, category: string, label: string, on: boolean) {
  const { data: fresh, error } = await supabase.from('trades').select('id, tags_json').eq('id', tradeId).maybeSingle()
  if (error) throw error
  if (!fresh) throw new Error('trade not found')
  const tags = { ...(fresh.tags_json ?? {}) } as Record<string, unknown>
  const cur = normalizeTagArray(tags[category])
  if (cur.includes(label) === on) return
  const next = on ? [...cur, label] : cur.filter(l => l !== label)
  if (next.length) tags[category] = next
  else delete tags[category]
  const { error: we } = await supabase.from('trades').update({ tags_json: tags, updated_at: new Date().toISOString() }).eq('id', tradeId)
  if (we) throw we
}

/** ✓ — the trader says these coach tags are right. */
export async function keepTags(supabase: AnyClient, tradeId: string, keys: readonly string[]) {
  await decide(supabase, (await pickRows(supabase, tradeId, keys)).map(r => r.id), 'kept')
}

/** ✕ — the tag comes off the trade, and the coach got it wrong. */
export async function removeTag(supabase: AnyClient, tradeId: string, key: string) {
  const rows = await pickRows(supabase, tradeId, [key])
  if (!rows.length) throw new Error('not a coach tag on this trade')
  await setTagOnTrade(supabase, tradeId, rows[0].category, rows[0].label, false)
  await decide(supabase, rows.map(r => r.id), 'removed')
}

/** Undo either — back to "to check"; a tag the coach had put on goes back on. */
export async function undoTag(supabase: AnyClient, tradeId: string, key: string) {
  const rows = await pickRows(supabase, tradeId, [key])
  if (!rows.length) throw new Error('not a coach tag on this trade')
  if (rows.some(r => r.decision === 'removed') && rows.some(r => r.applied)) {
    await setTagOnTrade(supabase, tradeId, rows[0].category, rows[0].label, true)
  }
  await decide(supabase, rows.map(r => r.id), null)
}

// ── Weekly review: "Check the coach's tags" ───────────────────────────────────

export interface WeekTrade {
  id: string
  /** The trade's session date, YYYY-MM-DD. */
  date: string | null
  entry_time: string | null
  direction: 'long' | 'short' | null
  pnl: number | null
  tags_json: Record<string, unknown> | null
}

const GROUPS: ReadonlyArray<{ key: string; label: string }> = [...TRADE_TAG_CATS, { key: 'day_type', label: 'Day type' }]
const groupLabel = (key: string) => GROUPS.find(g => g.key === key)?.label ?? key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())

/**
 * The week's trades the coach picked tags on, ready for CoachTagCheck, plus
 * the kept / taken-off counts over every other week for its one-line summary.
 * null when the coach picked nothing this week (the section stays off).
 */
export async function buildWeekCheck(supabase: AnyClient, weekTrades: readonly WeekTrade[]): Promise<CoachCheckData | null> {
  const all = await loadTradeAudits(supabase)
  if (!all.length) return null
  const byId = new Map(all.map(a => [a.tradeId, a]))
  const weekIds = new Set(weekTrades.map(t => t.id))
  let otherKept = 0, otherRemoved = 0
  for (const a of all) {
    if (weekIds.has(a.tradeId)) continue
    for (const t of a.tags) { if (t.outcome === 'kept') otherKept++; else if (t.outcome === 'removed') otherRemoved++ }
  }
  const trades: CoachCheckTrade[] = []
  for (const t of weekTrades) {
    const audit = byId.get(t.id)
    if (!audit) continue
    const coach = new Map(audit.tags.map(a => [auditKey(a.category, a.label), a]))
    const tj = t.tags_json ?? {}
    const keys = [...GROUPS.map(g => g.key), ...Object.keys(tj).filter(k => !GROUPS.some(g => g.key === k))]
    const groups: CoachCheckTrade['groups'] = []
    for (const cat of keys) {
      const chips: CoachCheckChip[] = []
      const chip = (label: string): CoachCheckChip => {
        const key = auditKey(cat, label)
        const a = coach.get(key)
        return a
          ? { key, label, kind: 'coach', outcome: a.outcome, conf: a.conf, reason: a.reason, source: a.source }
          : { key, label, kind: 'you' }
      }
      for (const label of normalizeTagArray(tj[cat])) if (label) chips.push(chip(label))
      // a coach tag taken off is still listed, so it can be undone
      for (const a of audit.tags) if (a.category === cat && a.outcome === 'removed') chips.push(chip(a.label))
      if (chips.length) groups.push({ name: groupLabel(cat), chips })
    }
    const entry = t.entry_time ? new Date(t.entry_time) : null
    trades.push({
      id: t.id,
      day: t.date ? new Date(`${t.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' }) : '',
      time: entry ? entry.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }) : '',
      dir: t.direction === 'long' ? 'Long' : t.direction === 'short' ? 'Short' : '',
      pnl: t.pnl,
      href: t.date ? `/review/today/${t.date}?trade=${t.id}` : '#',
      groups,
    })
  }
  return trades.length ? { trades, otherKept, otherRemoved } : null
}
