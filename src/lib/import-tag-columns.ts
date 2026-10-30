/**
 * Bringing a trader's tags and notes over on import (founder-approved,
 * docs/tapescore-onboarding-mockup-r2.html §①b).
 *
 * Pure — no DB — so the browser can show "We found your tags" before upload
 * and the import route applies the trader's choices to the same rows.
 *
 *   detectTagColumns()  which columns hold tags or notes, and where each goes
 *   tagsForRow()        one row's tags (by group) and notes, under a mapping
 *
 * A column is offered when it isn't a trade field (time, price, P&L …) and its
 * values read as words, not numbers, dates or true/false. Its suggested home:
 *   - a built-in group when the column's NAME matches it (Setups, Playbook →
 *     Setups; Mistakes; Emotion → Emotions; …) — the coach's read and Edge
 *     Analysis look for setups and mistakes there;
 *   - "notes" for Notes / Comments / Journal;
 *   - "leave out" for account, status and ID-style columns;
 *   - otherwise a NEW group named after the trader's own column, so nothing is
 *     forced into our vocabulary.
 */
import { BUILTIN_TAG_CATEGORIES, isValidCategoryKey, slugifyCategoryKey } from './tag-categories'
import { normKey, readCsvRecords, TRADE_FIELD_KEYS } from './csv-trade-import'
import { isNinjaTraderGrid } from './ninjatrader-import'
import { isSierraLogText } from './sc-accounts'
import { tagKey } from './tradezella-import'

export type TagTarget =
  | { kind: 'group'; key: string; label: string; isNew: boolean }
  | { kind: 'notes' }
  | { kind: 'skip' }

export interface TagColumn {
  header: string
  index: number
  /** Rows with a value in this column. */
  filled: number
  /** Distinct tags (after splitting), or distinct notes for a notes column. */
  distinct: number
  /** The most common values, for the preview. */
  examples: string[]
  suggested: TagTarget
}

export interface TagMapEntry { header: string; target: TagTarget }

/** A tag longer than this is a sentence, not a tag — dropped, and counted. */
export const MAX_TAG_LEN = 60
/** Group labels are kept short enough to sit in a picker heading. */
export const MAX_GROUP_LABEL = 40

const BUILTIN_BY_NAME: Record<string, string> = {
  setup: 'setups', setups: 'setups', playbook: 'setups', playbooks: 'setups', strategy: 'setups', strategies: 'setups',
  mistake: 'mistakes', mistakes: 'mistakes', error: 'mistakes', errors: 'mistakes',
  emotion: 'emotions', emotions: 'emotions', mood: 'emotions', feeling: 'emotions', feelings: 'emotions', psychology: 'emotions',
  daytype: 'day_type', daytypes: 'day_type',
  trademanagement: 'trade_management', management: 'trade_management',
  orderflow: 'order_flow',
  entrymodel: 'entry_model', entrymodels: 'entry_model',
  confluence: 'confluences', confluences: 'confluences',
}
const NOTES_NAMES = new Set(['notes', 'note', 'comment', 'comments', 'journal', 'description', 'tradenotes', 'review', 'reviewnotes'])
const SKIP_NAMES = new Set([
  'account', 'accountname', 'accountid', 'accountnumber', 'broker', 'id', 'tradeid', 'uuid', 'orderid',
  'currency', 'status', 'result', 'outcome', 'winloss', 'spreadtype', 'assetclass', 'assettype', 'exchange',
  'reviewed', 'rating', 'grade', 'timeframe',
])

const builtinLabel = (key: string) => BUILTIN_TAG_CATEGORIES.find(c => c.key === key)?.label ?? key

/** "Numbers, dates, times, true/false" — not words. */
function looksLikeData(v: string): boolean {
  const s = v.trim()
  if (/^(true|false|yes|no)$/i.test(s)) return true
  if (/^[-+($]*[\d.,]+%?\)?$/.test(s)) return true
  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(s)) return true
  if (/^\d{1,2}:\d{2}(:\d{2})?(\s*[A-Za-z]{2,4})?$/.test(s)) return true
  return false
}

/** One cell's tags: split on commas, semicolons and pipes, trimmed, no blanks. */
export function splitTagValues(cell: string | undefined): string[] {
  if (!cell) return []
  return cell.split(/[,;|]/).map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean)
}

/** Where a column goes by its name alone. */
export function suggestTarget(header: string): TagTarget {
  const k = normKey(header)
  if (NOTES_NAMES.has(k)) return { kind: 'notes' }
  if (SKIP_NAMES.has(k)) return { kind: 'skip' }
  const builtin = BUILTIN_BY_NAME[k]
  if (builtin) return { kind: 'group', key: builtin, label: builtinLabel(builtin), isNew: false }
  return newGroupTarget(header)
}

/** A new group named after the trader's column. A name that slugs to a
 *  built-in key is that built-in. Null when the name can't make a key. */
export function newGroupTarget(header: string): TagTarget {
  const label = header.trim().replace(/\s+/g, ' ').slice(0, MAX_GROUP_LABEL)
  const key = slugifyCategoryKey(label)
  if (!key) return { kind: 'skip' }
  if (BUILTIN_TAG_CATEGORIES.some(c => c.key === key)) return { kind: 'group', key, label: builtinLabel(key), isNew: false }
  return { kind: 'group', key, label, isNew: true }
}

/**
 * The columns worth offering, in file order. `rows` are data rows (no header).
 * A column is offered when it isn't a trade field, has a value somewhere, and
 * most of its values are words.
 */
export function detectTagColumns(headers: string[], rows: string[][]): TagColumn[] {
  const out: TagColumn[] = []
  headers.forEach((header, index) => {
    const k = normKey(header)
    if (!k || TRADE_FIELD_KEYS.has(k)) return
    const values = rows.map(r => (r[index] ?? '').trim()).filter(Boolean)
    if (values.length === 0) return
    const wordy = values.filter(v => !looksLikeData(v)).length
    if (wordy / values.length < 0.8) return

    const suggested = suggestTarget(header)
    const counts = new Map<string, { label: string; n: number }>()
    if (suggested.kind === 'notes') {
      for (const v of values) counts.set(v, { label: v, n: (counts.get(v)?.n ?? 0) + 1 })
    } else {
      for (const v of values) {
        for (const t of splitTagValues(v)) {
          const key = tagKey(t)
          if (!key) continue
          const prev = counts.get(key)
          counts.set(key, { label: prev?.label ?? t, n: (prev?.n ?? 0) + 1 })
        }
      }
    }
    const examples = [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map(c => (c.label.length > 48 ? `${c.label.slice(0, 47)}…` : c.label))
    out.push({ header, index, filled: values.length, distinct: counts.size, examples, suggested })
  })
  return out
}

/** The columns to offer for a picked file: none for a Sierra Chart log or a
 *  NinjaTrader executions grid (fills, no tags), and none when every column
 *  found would be left out anyway — then the upload goes straight through. */
export function tagColumnsInFile(text: string): TagColumn[] {
  if (isSierraLogText(text) || isNinjaTraderGrid(text)) return []
  const recs = readCsvRecords(text)
  if (recs.length < 2) return []
  const cols = detectTagColumns(recs[0], recs.slice(1))
  return cols.some(c => c.suggested.kind !== 'skip') ? cols : []
}

/** Validate a mapping that came over the wire; drops anything malformed. */
export function readTagMap(raw: unknown, headers: string[]): TagMapEntry[] {
  if (!Array.isArray(raw)) return []
  const known = new Set(headers)
  const out: TagMapEntry[] = []
  const seen = new Set<string>()
  for (const e of raw.slice(0, 60)) {
    const header = typeof e?.header === 'string' ? e.header : ''
    if (!known.has(header) || seen.has(header)) continue
    const t = e?.target
    if (t?.kind === 'notes' || t?.kind === 'skip') { out.push({ header, target: { kind: t.kind } }); seen.add(header); continue }
    if (t?.kind !== 'group' || typeof t.key !== 'string' || !isValidCategoryKey(t.key)) continue
    const builtin = BUILTIN_TAG_CATEGORIES.some(c => c.key === t.key)
    const label = builtin
      ? builtinLabel(t.key)
      : (typeof t.label === 'string' && t.label.trim() ? t.label.trim().slice(0, MAX_GROUP_LABEL) : t.key)
    out.push({ header, target: { kind: 'group', key: t.key, label, isNew: !builtin } })
    seen.add(header)
  }
  return out
}

/**
 * One row's tags by group and its notes, under a mapping. Tags are tidied
 * (an all-lowercase tag gets a capital first letter — "break and retest" →
 * "Break and retest"; Title Casing every word mangled "would've") and
 * de-duplicated by tagKey within each group; over-long values are counted in
 * `dropped`. Several notes columns join with a blank line.
 */
export function tagsForRow(
  cells: string[],
  headers: string[],
  map: TagMapEntry[],
): { tags: Record<string, string[]>; notes: string | null; dropped: number } {
  const tags: Record<string, string[]> = {}
  const keysSeen: Record<string, Set<string>> = {}
  const notes: string[] = []
  let dropped = 0
  for (const { header, target } of map) {
    if (target.kind === 'skip') continue
    const idx = headers.indexOf(header)
    const cell = idx >= 0 ? (cells[idx] ?? '').trim() : ''
    if (!cell) continue
    if (target.kind === 'notes') { notes.push(cell); continue }
    for (const raw of splitTagValues(cell)) {
      if (raw.length > MAX_TAG_LEN) { dropped++; continue }
      const label = raw === raw.toLowerCase() ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw
      const key = tagKey(label)
      if (!key) continue
      const seen = (keysSeen[target.key] ??= new Set())
      if (seen.has(key)) continue
      seen.add(key)
      ;(tags[target.key] ??= []).push(label)
    }
  }
  return { tags, notes: notes.length ? notes.join('\n\n') : null, dropped }
}
