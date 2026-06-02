/**
 * Suggest tags by keyword-matching against a free-text field (e.g. the trade
 * Notes box). Tags whose significant words ALL appear in the text are
 * suggested. Stopwords ("and", "the", "of", "&" → "and") are ignored so
 * "Break And Retest" can match notes like "break retest vwap" without
 * requiring the literal "and".
 *
 * Beyond exact word match, the matcher normalizes to bridge common natural-
 * language variants of the same concept:
 *   - Ordinal suffixes: "2nd" ↔ "2", "3rd" ↔ "3", "21st" ↔ "21"
 *   - English number words: "second" ↔ "2", "third" ↔ "3" (one–ten)
 *   - Singulars: "clusters" ↔ "cluster", "attempts" ↔ "attempt"
 *   - Slash alternatives in tag labels: "Clusters/Bubbles" means EITHER
 *     "clusters" OR "bubbles" can satisfy that token, not both.
 *
 * Suggestions feed into TradeForm's auto-add path. User can still manually
 * remove auto-added tags; the autoAddedRef there prevents re-adding once
 * removed.
 */

import type { TradeTag, TradeTags, TagCategory } from './supabase/types'
import { normalizeTagArray } from './supabase/types'

const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for',
  'is', 'it', 'be', 'with', 'by', 'as', 'vs',
])

// English number words → digits. Cardinal + ordinal forms one through ten.
// Covers the common cases where a tag uses "Second Attempt" but the trader
// types "attempt 2" (or vice versa). Capped at ten — past that, traders
// almost always use digits.
const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
  sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
}

/** Normalize English ordinal suffixes to bare digits ("2nd" → "2"). */
function normalizeOrdinal(w: string): string {
  const m = w.match(/^(\d+)(st|nd|rd|th)$/)
  return m ? m[1] : w
}

/** Conservative singular: strip trailing "s" if it's clearly plural form.
 *  Skips short words and Latin-style endings (ss/us/is) to avoid stripping
 *  "pass", "plus", "axis", etc. */
function singularize(w: string): string {
  if (w.length < 5 || !w.endsWith('s')) return w
  if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return w
  return w.slice(0, -1)
}

/** Full normalization pipeline applied to every token on both sides. */
function normalizePart(w: string): string {
  if (!w) return ''
  let t = w.toLowerCase()
  t = normalizeOrdinal(t)
  if (NUMBER_WORDS[t]) t = NUMBER_WORDS[t]
  t = singularize(t)
  return t
}

function isSignificant(w: string): boolean {
  if (!w || STOPWORDS.has(w)) return false
  return w.length > 1 || /^\d$/.test(w)
}

/**
 * Tokenize free text into a deduped Set. "&" folds to "and"; all non-
 * alphanumerics become whitespace. Each surviving token is run through
 * `normalizePart` (ordinal → digit, number-word → digit, plural → singular).
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map(normalizePart)
      .filter(isSignificant),
  )
}

/**
 * Tag keywords as a structured list. Plain string = required token. Inner
 * array = "satisfy ANY of these" (used for slash alternatives like
 * "Clusters/Bubbles"). Stopwords and empty groups are dropped.
 */
type KeywordReq = string | string[]

function tagKeywords(label: string): KeywordReq[] {
  // Preserve "/" through the initial strip so we can detect alternatives.
  const cleaned = label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9/\s]/g, ' ')
  const reqs: KeywordReq[] = []
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue
    if (raw.includes('/')) {
      const alts = raw.split('/').map(normalizePart).filter(isSignificant)
      if (alts.length === 1) reqs.push(alts[0])
      else if (alts.length >= 2) reqs.push(Array.from(new Set(alts)))
      // Empty alt set → skip (e.g., "/" alone or all stopwords)
    } else {
      const t = normalizePart(raw)
      if (isSignificant(t)) reqs.push(t)
    }
  }
  return reqs
}

/** Match a structured tag requirement list against a notes-token set. */
function matchKeywords(reqs: KeywordReq[], tokens: Set<string>): boolean {
  if (reqs.length === 0) return false
  for (const req of reqs) {
    if (typeof req === 'string') {
      if (!tokens.has(req)) return false
    } else {
      // Slash group — at least one alternative must be in the tokens.
      if (!req.some(alt => tokens.has(alt))) return false
    }
  }
  return true
}

/**
 * Suggest tags whose keyword requirements are satisfied by the text.
 * Returns a TradeTags object grouped by category. Empty when text < 3 chars.
 */
export function suggestTagsFromText(text: string, allTags: TradeTag[]): TradeTags {
  if (!text || text.trim().length < 3) return {}
  const tokens = tokenize(text)
  const out: Partial<Record<TagCategory, string[]>> = {}
  for (const tag of allTags) {
    const reqs = tagKeywords(tag.label)
    if (!matchKeywords(reqs, tokens)) continue
    const cat = tag.category
    const arr = out[cat] ?? []
    if (!arr.includes(tag.label)) arr.push(tag.label)
    out[cat] = arr
  }
  return out as TradeTags
}

/**
 * Union two TradeTags objects (per-category, deduped). Used to merge OCR
 * suggestions with notes auto-add results.
 */
export function mergeTradeTags(a: TradeTags | undefined, b: TradeTags | undefined): TradeTags {
  const out: Partial<Record<TagCategory, string[] | string>> = {}
  const cats = new Set<TagCategory>([
    ...(Object.keys(a ?? {}) as TagCategory[]),
    ...(Object.keys(b ?? {}) as TagCategory[]),
  ])
  for (const cat of cats) {
    const arrA = normalizeTagArray(a?.[cat])
    const arrB = normalizeTagArray(b?.[cat])
    const combined = Array.from(new Set([...arrA, ...arrB]))
    if (combined.length > 0) out[cat] = combined
  }
  return out as TradeTags
}
