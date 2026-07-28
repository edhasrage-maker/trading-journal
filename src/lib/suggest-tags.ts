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

/**
 * Ordered, normalized token list — keeps duplicates AND stopwords, unlike
 * `tokenize`. Aliases are matched as contiguous PHRASES against this.
 */
function phraseTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(normalizePart)
    .filter(Boolean)
}

/** True when `needle` appears as a contiguous run inside `haystack`. */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
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
 *
 * A tag matches on its LABEL or on any of its ALIASES. Aliases exist because
 * the label is a phrase and the notes are prose: "VWAP Hold/Bounce" requires
 * both "vwap" AND ("hold" OR "bounce"), so a note reading "the increased
 * volatility at VWAP" matches nothing, even though it plainly refers to the
 * level. Real misses from live notes: "wrong size" → Oversized, "BOC" → Break
 * of Candle, "HUGE sellers on the DBP" → Large Delta on DBP. In every case no
 * significant word overlaps, so no amount of stemming would bridge it — only
 * the trader's own vocabulary can.
 *
 * Labels and aliases match by DIFFERENT rules, deliberately.
 *
 * A label is matched as a bag of significant words, stopwords dropped, because
 * a label is a name and word order in the notes is arbitrary. An ALIAS is
 * matched as a contiguous PHRASE with stopwords KEPT, because an alias is
 * literally something the trader types.
 *
 * Applying the label rule to aliases silently destroys precision: "at vwap"
 * would drop "at" as a stopword, collapse to bare "vwap", and then fire
 * VWAP Hold/Bounce on "price broke through VWAP" — the opposite trade. Phrase
 * matching keeps "at vwap" meaning what it says. A single-word alias ("boc")
 * is still a deliberate broad catch; that choice belongs to the trader, which
 * is why aliases are editable data rather than code.
 */
export function suggestTagsFromText(text: string, allTags: TradeTag[]): TradeTags {
  if (!text || text.trim().length < 3) return {}
  const tokens = tokenize(text)
  const phrase = phraseTokens(text)
  const out: Partial<Record<TagCategory, string[]>> = {}
  for (const tag of allTags) {
    if (!matchesTag(tag, tokens, phrase)) continue
    const cat = tag.category
    const arr = out[cat] ?? []
    if (!arr.includes(tag.label)) arr.push(tag.label)
    out[cat] = arr
  }
  return out as TradeTags
}

/**
 * An alias beginning with `!` is an EXCLUSION: if that phrase appears, the tag
 * is suppressed no matter what else matched.
 *
 * Needed because a one-word label can be ambiguous in the trader's own
 * vocabulary. Real case: "Took this bc of oversized IB way above avg" tagged
 * the MISTAKE `Oversized` — but that sentence describes a wide initial
 * balance, not the position size. A wrong tag is worse than a missing one here,
 * because these feed Entry scoring, so `!oversized ib` suppresses it while
 * plain "oversized" keeps working.
 *
 * Same column, same phrase-matching rule, no extra schema.
 */
const isExclusion = (a: string): boolean => a.trimStart().startsWith('!')
const exclusionBody = (a: string): string => a.trimStart().slice(1)

/** True when the tag's label (bag of words) or any alias (phrase) matches. */
function matchesTag(tag: TradeTag, tokens: Set<string>, phrase: string[]): boolean {
  const aliases = (tag.aliases ?? []).filter(a => typeof a === 'string' && a.trim())
  // Exclusions win over everything, so check them first.
  for (const a of aliases) {
    if (isExclusion(a) && containsPhrase(phrase, phraseTokens(exclusionBody(a)))) return false
  }
  if (matchKeywords(tagKeywords(tag.label), tokens)) return true
  for (const a of aliases) {
    if (isExclusion(a)) continue
    if (containsPhrase(phrase, phraseTokens(a))) return true
  }
  return false
}

/**
 * Which alias (or the label) caused a tag to match. Returns null when it does
 * not match at all.
 *
 * This is what the learning loop writes back against: when the trader confirms
 * an AI-suggested tag, the phrase that triggered it becomes a new alias, so the
 * deterministic layer catches it next time and the LLM is asked less often.
 */
export function matchReason(tag: TradeTag, text: string): string | null {
  if (!text || text.trim().length < 3) return null
  const phrase = phraseTokens(text)
  if (!matchesTag(tag, tokenize(text), phrase)) return null
  if (matchKeywords(tagKeywords(tag.label), tokenize(text))) return tag.label
  for (const alias of tag.aliases ?? []) {
    if (typeof alias !== 'string' || !alias.trim() || isExclusion(alias)) continue
    if (containsPhrase(phrase, phraseTokens(alias))) return alias
  }
  return null
}

/**
 * Add `phrase` to a tag's alias list, deduped case-insensitively. Pure — the
 * caller persists the result. Returns the list unchanged when the phrase is
 * empty, already present, or already implied by the label (no point storing an
 * alias the label would have matched anyway).
 */
export function addAlias(tag: TradeTag, phrase: string): string[] {
  const existing = (tag.aliases ?? []).filter(a => typeof a === 'string' && a.trim())
  const clean = phrase.trim()
  if (!clean) return existing
  if (existing.some(a => a.toLowerCase() === clean.toLowerCase())) return existing
  // Would the label already have caught it? Then it adds nothing.
  if (matchKeywords(tagKeywords(tag.label), tokenize(clean))) return existing
  return [...existing, clean]
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
