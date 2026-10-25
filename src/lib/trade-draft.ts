/**
 * Unsaved trade-form edits, kept in this browser so a stray Esc, a click
 * outside the edit drawer, a page change or a closed tab can't throw typed
 * notes away. One draft per trade (per day for a not-yet-saved new trade).
 *
 * A draft stores the form as it was when editing started (`from`) next to the
 * edited form (`fields`). Restoring re-applies only the fields the trader
 * actually changed, on top of the trade as it is NOW — so a background job
 * that touched the trade in between (re-scoring, a backfill) neither drops the
 * draft nor gets reverted by it.
 *
 * Every storage call is guarded — private windows and blocked site data throw
 * on access, and losing the safety net must never break the form itself.
 */
import { normalizeTagArray, type TagCategory, type TradeTags } from '@/lib/supabase/types'

/** What a draft keeps: everything the trader typed or picked in the trade
 *  form. Not the screenshot (a pasted file can't survive a reload) and not the
 *  AI suggestion chips (re-derivable). */
export interface DraftFields {
  direction: 'long' | 'short'
  symbol: string
  entry_time: string
  entry_price: string
  stop_price: string
  tp1_price: string
  quantity: string
  pnl: string
  notes: string
  tags: TradeTags
}

const DRAFT_KEYS = [
  'direction', 'symbol', 'entry_time', 'entry_price', 'stop_price',
  'tp1_price', 'quantity', 'pnl', 'notes', 'tags',
] as const satisfies readonly (keyof DraftFields)[]

export interface TradeDraft {
  v: 2
  savedAt: string
  /** The form as loaded, before the trader's edits. */
  from: DraftFields
  /** The form with the trader's edits. */
  fields: DraftFields
}

export const DISCARD_TRADE_EDITS_MESSAGE = 'Discard your unsaved changes to this trade?'

/** Just the draft fields of a (wider) form state. */
export function pickDraftFields(f: DraftFields): DraftFields {
  return {
    direction: f.direction, symbol: f.symbol, entry_time: f.entry_time,
    entry_price: f.entry_price, stop_price: f.stop_price, tp1_price: f.tp1_price,
    quantity: f.quantity, pnl: f.pnl, notes: f.notes, tags: f.tags,
  }
}

/** Tag selection as a comparable string: labels sorted, empty categories
 *  dropped, so the same selection always compares equal. */
function tagsSignature(tags: TradeTags | undefined): string {
  return JSON.stringify((Object.keys(tags ?? {}) as TagCategory[])
    .sort()
    .map(cat => [cat, [...normalizeTagArray(tags?.[cat])].sort()] as const)
    .filter(([, labels]) => labels.length > 0))
}

/** "Has anything changed?" fingerprint of the draft fields. */
export function draftSignature(d: DraftFields): string {
  return JSON.stringify(DRAFT_KEYS.map(k => (k === 'tags' ? tagsSignature(d.tags) : d[k])))
}

/** The fields edited between `from` and `to` — what a draft re-applies. */
export function editedFields(from: DraftFields, to: DraftFields): Partial<DraftFields> {
  const out: Partial<DraftFields> = {}
  for (const k of DRAFT_KEYS) {
    const changed = k === 'tags' ? tagsSignature(from.tags) !== tagsSignature(to.tags) : from[k] !== to[k]
    if (changed) Object.assign(out, { [k]: to[k] })
  }
  return out
}

/** A draft laid over the trade as it is now: its edits on top of `current`.
 *  Null when that changes nothing (the draft is stale or already saved). */
export function restoreDraft(draft: TradeDraft, current: DraftFields): DraftFields | null {
  const restored = { ...current, ...editedFields(draft.from, draft.fields) }
  return draftSignature(restored) === draftSignature(current) ? null : restored
}

export function tradeDraftKey(tradeId: string | null | undefined, date: string): string {
  return `trade-draft:${tradeId ?? `new:${date}`}`
}

export function readTradeDraft(key: string): TradeDraft | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const draft = JSON.parse(raw) as TradeDraft
    return draft && draft.v === 2 && draft.from && draft.fields ? draft : null
  } catch {
    return null
  }
}

export function writeTradeDraft(key: string, from: DraftFields, fields: DraftFields): void {
  try {
    const draft: TradeDraft = { v: 2, savedAt: new Date().toISOString(), from, fields }
    window.localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Storage full or blocked — the beforeunload guard is still in place.
  }
}

export function clearTradeDraft(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
