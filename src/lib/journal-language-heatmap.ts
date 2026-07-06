/**
 * Journal Language Heatmap — mine the trader's OWN free-text across all four
 * journal surfaces (prep, intraday, EOD, weekly) for recurring words/phrases +
 * emotional language, correlate each to outcomes, and emit a prompt block the
 * AI coach reacts to.
 *
 * Deterministic by design (Pt 3 fork 1): a pure function computes the "heatmap"
 * (phrase frequency + an emotion lexicon + outcome correlation); the coach —
 * already an LLM — does the semantic interpretation and the uplift. No second
 * API call, no cache table (fork 4: live-compute). Mirrors the shape of
 * `behavioralProxiesPromptBlock` in `behavioral-proxies.ts`: pure compute →
 * prompt string, `''` when there's no signal so a thin corpus adds no weight.
 *
 * These are OBSERVATIONS the coach weaves into its narrative, NOT scoring
 * criteria — same framing as the behavioral proxies.
 *
 * Granularity (fork 2): per-TRADE for intraday notes → trade PnL; DAY-level for
 * prep/EOD → day PnL + process compliance; WEEK-level for weekly (frequency
 * only). The two motivating examples split across these: "thought I saw selling"
 * is per-trade (→ loss), "hate myself" is day-level (→ often a fine day).
 *
 * The uplift loop (fork 5) is a prompt DIRECTIVE embedded in the block, derived
 * from the correlations: recurring self-criticism / low-confidence language that
 * lands on process-compliant or net-green units → tell the coach to surface
 * positive data; hedged/uncertain read language that precedes losses → flag it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export type JournalSource = 'prep' | 'intraday' | 'eod' | 'weekly'

/** One unit of trader-authored free text with the outcome of its unit attached. */
export interface JournalEntry {
  source: JournalSource
  /** YYYY-MM-DD — day date, or the week-start date for weekly entries. */
  date: string
  /** Raw free text (prep entries concatenate several PrepNotes fields). */
  text: string
  /** Outcome $ of the unit: trade PnL (intraday) or day eod_pnl (prep/eod). null for weekly. */
  pnl: number | null
  /** Day-level process verdict, when known (prep/eod entries only). */
  processCompliant?: boolean | null
}

export interface PhraseHit {
  phrase: string
  /** Distinct entries the phrase appears in. */
  count: number
  sources: JournalSource[]
  winCount: number
  lossCount: number
  /** Mean PnL across units that mention it (excludes null-PnL / weekly units). */
  avgPnl: number | null
}

export type EmotionCategory =
  | 'self_criticism'
  | 'low_confidence'
  | 'uncertain_read'
  | 'tilt'
  | 'conviction'

export interface EmotionHit {
  category: EmotionCategory
  label: string
  /** Distinct entries with ≥1 lexicon match. */
  count: number
  sources: JournalSource[]
  winCount: number
  lossCount: number
  avgPnl: number | null
  /** Fraction of PnL-bearing units that were on a process-Compliant day. */
  compliantShare: number | null
  /** Up to 2 short verbatim quotes for the coach to reference. */
  examples: Array<{ date: string; text: string }>
}

export interface JournalHeatmap {
  entryCount: number
  sourceCounts: Record<JournalSource, number>
  hasSignal: boolean
  phrases: PhraseHit[]
  emotions: EmotionHit[]
  /** Uplift directive payload — recurring negative self-talk on days that were fine. */
  uplift: { category: EmotionCategory; count: number; note: string } | null
  /** Flag directive payload — hedged read language that precedes losses. */
  flag: { count: number; note: string } | null
}

// ── Tunables ────────────────────────────────────────────────────────────────
/** Below this many entries the corpus is too thin to read patterns from. */
const MIN_ENTRIES = 5
/** A phrase must appear in at least this many DISTINCT entries to be "recurring". */
const PHRASE_MIN_ENTRIES = 3
/** An emotion category needs at least this many hits to report. */
const EMOTION_MIN_HITS = 2
/** Ignore entries shorter than this (whitespace-trimmed). */
const MIN_TEXT_LEN = 15
/** Cap the block size (LENGTH DISCIPLINE — the EOD prompt is token-sensitive). */
const MAX_PHRASES = 6
const MAX_EMOTIONS = 5

// ── Lexicons ──────────────────────────────────────────────────────────────────
/** Common English stopwords — dropped before n-gram counting. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'of', 'to', 'in',
  'on', 'at', 'by', 'for', 'with', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'im',
  'ive', 'id', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'them', 'his', 'her', 'do', 'did', 'does', 'done', 'have', 'has', 'had',
  'not', 'no', 'yes', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'just', 'too', 'very', 'more', 'most', 'some', 'any', 'all', 'both', 'each',
  'few', 'other', 'than', 'into', 'from', 'about', 'get', 'got', 'go', 'went',
  'going', 'gonna', 'like', 'really', 'still', 'even', 'also', 'back', 'there',
  'here', 'when', 'where', 'what', 'which', 'who', 'how', 'why', 'because',
  'would', 'could', 'should', 'will', 'can', 'cant', 'wont', 'didnt', 'dont',
  'am', 'one', 'two', 'day', 'today', 'trade', 'trades', 'price',
  // temporal / filler / discourse words — no framing value as recurring phrases
  'now', 'after', 'before', 'good', 'bad', 'well', 'okay', 'bc', 'cuz', 'though',
  'thing', 'things', 'want', 'wanted', 'need', 'needed', 'know', 'knew', 'think',
  'thought', 'take', 'took', 'taken', 'taking', 'see', 'saw', 'made', 'make',
  'come', 'came', 'put', 'keep', 'kept', 'let', 'lot', 'pretty', 'much', 'way',
  'right', 'left', 'first', 'last', 'next', 'time', 'bit', 'kinda', 'sorta',
])

/** Trader vocabulary / tickers / indicators — nouns, not framings (per the
 *  Journal Themes prompt these are vocabulary and must not surface as patterns). */
const TRADER_VOCAB = new Set([
  'vwap', 'ema', 'rvol', 'adr', 'atr', 'ib', 'ibh', 'ibl', 'onh', 'onl',
  'pdh', 'pdl', 'dll', 'mgi', 'nq', 'mnq', 'es', 'mes', 'rth', 'eth', 'gbx',
  'tp1', 'tp2', 'aoi', 'mfe', 'mae', 'rr', 'pf', 'sd', 'poc', 'val', 'vah',
  'hod', 'lod', 'bos', 'choch', 'fvg', 'ote', 'sl', 'tp', 'r', 'pt', 'pts',
  'long', 'short', 'setup', 'entry', 'exit', 'stop', 'target', 'level',
])

/**
 * Emotion lexicon. Each phrase is matched with word boundaries (case-insensitive)
 * so multi-word phrases like "thought i saw" fire on the surrounding sentence.
 * Order matters only for display labels.
 */
const EMOTION_LEXICON: Record<EmotionCategory, { label: string; phrases: string[] }> = {
  self_criticism: {
    label: 'Self-criticism',
    phrases: [
      'hate myself', 'hate that i', 'i suck', 'so stupid', 'stupid', 'idiot',
      'idiotic', 'pathetic', 'ashamed', 'embarrassed', 'disgusted', 'kick myself',
      'beat myself', 'so dumb', 'dumb', 'terrible', 'awful', 'garbage', 'trash',
      'undisciplined', 'no discipline', 'my fault',
    ],
  },
  low_confidence: {
    label: 'Low confidence',
    phrases: [
      'not sure', 'unsure', 'no confidence', 'lack confidence', 'hesitant',
      'hesitated', 'hesitation', 'scared', 'afraid', 'nervous', 'anxious',
      'doubt', 'doubted', 'second guess', 'second-guess', 'tentative',
      'gun shy', 'gun-shy', 'timid', 'froze', 'paralyzed', 'couldnt pull',
    ],
  },
  uncertain_read: {
    label: 'Hedged / uncertain read',
    phrases: [
      'thought i saw', 'thought i had', 'looked like', 'seemed like', 'felt like',
      'i think', 'i thought', 'maybe', 'might be', 'might have', 'not clear',
      'unclear', 'wasnt clear', 'no read', 'lost the read', 'guessing', 'guessed',
      'hoped', 'hoping', 'hope it', 'wishful',
    ],
  },
  tilt: {
    label: 'Tilt / frustration',
    phrases: [
      'frustrated', 'frustrating', 'angry', 'pissed', 'furious', 'annoyed',
      'revenge', 'forced', 'forcing', 'fomo', 'chased', 'chasing', 'rushed',
      'rushing', 'tilted', 'tilt', 'greedy', 'greed', 'impatient', 'overtrading',
      'overtraded', 'should have stopped',
    ],
  },
  conviction: {
    label: 'Conviction / discipline',
    phrases: [
      'clean', 'textbook', 'disciplined', 'patient', 'patience', 'waited',
      'confident', 'confidence', 'a plus', 'a+', 'great read', 'nailed',
      'trusted', 'trust the', 'stuck to', 'stuck with', 'let it run', 'in control',
    ],
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function outcomeOf(pnl: number | null): 'win' | 'loss' | null {
  return pnl == null ? null : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : null
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')          // drop apostrophes so "don't" → "dont"
    .replace(/[^a-z0-9+ ]+/g, ' ') // keep + for "a+"
    .replace(/\s+/g, ' ')
    .trim()
}

/** A token is meaningful if it's not a stopword, not trader vocab, and length ≥ 3. */
function isMeaningful(tok: string): boolean {
  if (tok.length < 3) return false
  if (STOPWORDS.has(tok)) return false
  if (TRADER_VOCAB.has(tok)) return false
  if (/^\d+$/.test(tok)) return false
  return true
}

/** Generate candidate phrases (salient unigrams + all bigrams/trigrams) for an entry. */
function phrasesOf(text: string): Set<string> {
  const toks = normalize(text).split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i < toks.length; i++) {
    if (isMeaningful(toks[i])) out.add(toks[i])
    if (i + 1 < toks.length) {
      const bi = `${toks[i]} ${toks[i + 1]}`
      // keep a bigram if at least one side is meaningful (captures "trust the read")
      if (isMeaningful(toks[i]) || isMeaningful(toks[i + 1])) out.add(bi)
    }
    if (i + 2 < toks.length) {
      const tri = `${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`
      if (isMeaningful(toks[i]) || isMeaningful(toks[i + 2])) out.add(tri)
    }
  }
  return out
}

// ── Core computation ──────────────────────────────────────────────────────────
/** Compute the deterministic heatmap over a corpus of journal entries. Pure. */
export function computeJournalHeatmap(entries: JournalEntry[]): JournalHeatmap {
  const kept = entries.filter(e => e.text != null && e.text.trim().length >= MIN_TEXT_LEN)

  const sourceCounts: Record<JournalSource, number> = { prep: 0, intraday: 0, eod: 0, weekly: 0 }
  for (const e of kept) sourceCounts[e.source]++

  // ── Recurring phrases ───────────────────────────────────────────────────────
  interface PhraseAgg {
    entries: number
    sources: Set<JournalSource>
    wins: number
    losses: number
    pnls: number[]
  }
  const phraseMap = new Map<string, PhraseAgg>()
  for (const e of kept) {
    const o = outcomeOf(e.pnl)
    for (const p of phrasesOf(e.text)) {
      let agg = phraseMap.get(p)
      if (!agg) { agg = { entries: 0, sources: new Set(), wins: 0, losses: 0, pnls: [] }; phraseMap.set(p, agg) }
      agg.entries++
      agg.sources.add(e.source)
      if (o === 'win') agg.wins++
      else if (o === 'loss') agg.losses++
      if (e.pnl != null) agg.pnls.push(e.pnl)
    }
  }
  // Prefer longer phrases: if a bigram/trigram recurs, drop unigrams fully
  // contained in it that share (roughly) the same count — reduces noise.
  const phraseEntries = Array.from(phraseMap.entries())
    .filter(([, a]) => a.entries >= PHRASE_MIN_ENTRIES)
  const multiWord = phraseEntries.filter(([p]) => p.includes(' ')).map(([p]) => p)
  const phrases: PhraseHit[] = phraseEntries
    .filter(([p, a]) => {
      if (p.includes(' ')) return true
      // drop a unigram if a multi-word phrase contains it with ≥ its own support
      return !multiWord.some(mw => mw.split(' ').includes(p) &&
        (phraseMap.get(mw)?.entries ?? 0) >= a.entries)
    })
    .map(([phrase, a]) => ({
      phrase,
      count: a.entries,
      sources: Array.from(a.sources),
      winCount: a.wins,
      lossCount: a.losses,
      avgPnl: mean(a.pnls),
    }))
    .sort((x, y) => y.count - x.count || (Math.abs(y.avgPnl ?? 0) - Math.abs(x.avgPnl ?? 0)))
    .slice(0, MAX_PHRASES)

  // ── Emotion lexicon ─────────────────────────────────────────────────────────
  const emotions: EmotionHit[] = []
  for (const cat of Object.keys(EMOTION_LEXICON) as EmotionCategory[]) {
    const { label, phrases: lex } = EMOTION_LEXICON[cat]
    const regexes = lex.map(p => new RegExp(`\\b${p.replace(/[+]/g, '\\+').replace(/\s+/g, '\\s+')}\\b`, 'i'))
    let count = 0
    const sources = new Set<JournalSource>()
    let wins = 0, losses = 0, compliant = 0, compliantDenom = 0
    const pnls: number[] = []
    const examples: Array<{ date: string; text: string }> = []
    for (const e of kept) {
      if (!regexes.some(r => r.test(e.text))) continue
      count++
      sources.add(e.source)
      const o = outcomeOf(e.pnl)
      if (o === 'win') wins++
      else if (o === 'loss') losses++
      if (e.pnl != null) pnls.push(e.pnl)
      if (e.processCompliant != null) { compliantDenom++; if (e.processCompliant) compliant++ }
      if (examples.length < 2) examples.push({ date: e.date, text: shorten(e.text) })
    }
    if (count >= EMOTION_MIN_HITS) {
      emotions.push({
        category: cat, label, count, sources: Array.from(sources),
        winCount: wins, lossCount: losses, avgPnl: mean(pnls),
        compliantShare: compliantDenom > 0 ? compliant / compliantDenom : null,
        examples,
      })
    }
  }
  emotions.sort((a, b) => b.count - a.count)
  const topEmotions = emotions.slice(0, MAX_EMOTIONS)

  // ── Uplift / flag derivation (fork 5) ───────────────────────────────────────
  // Uplift: recurring self-criticism / low-confidence that mostly lands on
  // process-compliant OR net-green units → the trader is harsher than the data.
  let uplift: JournalHeatmap['uplift'] = null
  for (const cat of ['self_criticism', 'low_confidence'] as EmotionCategory[]) {
    const em = emotions.find(e => e.category === cat)
    if (!em || em.count < EMOTION_MIN_HITS) continue
    const greenish = (em.avgPnl != null && em.avgPnl >= 0)
    const mostlyCompliant = (em.compliantShare != null && em.compliantShare >= 0.5)
    if (greenish || mostlyCompliant) {
      const bits: string[] = []
      if (mostlyCompliant) bits.push(`${Math.round((em.compliantShare ?? 0) * 100)}% on process-Compliant days`)
      if (greenish && em.avgPnl != null) bits.push(`avg ${fmtSignedUsd(em.avgPnl)} on those units`)
      uplift = {
        category: cat,
        count: em.count,
        note: `${em.label.toLowerCase()} recurs ${em.count}× (${bits.join(', ')}) — the trader is judging themselves harder than the record warrants. Acknowledge the feeling, then surface concrete positive data points from their own results to recalibrate; do NOT reinforce the negative frame.`,
      }
      break
    }
  }

  // Flag: hedged / uncertain read language that skews toward losses.
  let flag: JournalHeatmap['flag'] = null
  {
    const em = emotions.find(e => e.category === 'uncertain_read')
    if (em && em.count >= EMOTION_MIN_HITS && em.lossCount > em.winCount) {
      const denom = em.winCount + em.lossCount
      flag = {
        count: em.count,
        note: `hedged/uncertain read language ("thought I saw…", "looked like…") appears ${em.count}× and skews to losers (${em.lossCount}/${denom} losing${em.avgPnl != null ? `, avg ${fmtSignedUsd(em.avgPnl)}` : ''}) — flag the pattern: when the read isn't clean, the trade tends not to work.`,
      }
    }
  }

  const hasSignal = phrases.length > 0 || topEmotions.length > 0

  return {
    entryCount: kept.length,
    sourceCounts,
    hasSignal,
    phrases,
    emotions: topEmotions,
    uplift,
    flag,
  }
}

function shorten(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

function fmtSignedUsd(n: number): string {
  const r = Math.round(n)
  return `${r >= 0 ? '+' : '−'}$${Math.abs(r)}`
}

function outcomeTint(winCount: number, lossCount: number, avgPnl: number | null): string {
  const denom = winCount + lossCount
  if (denom === 0) return ''
  const pnlBit = avgPnl != null ? `, avg ${fmtSignedUsd(avgPnl)}` : ''
  return ` — ${winCount}W/${lossCount}L${pnlBit}`
}

const SOURCE_LABEL: Record<JournalSource, string> = {
  prep: 'prep', intraday: 'trade notes', eod: 'EOD', weekly: 'weekly',
}

/**
 * Format the heatmap as an interpreted context block for an AI prompt. Returns
 * '' when the corpus is too thin or shows no signal, so a clean/sparse journal
 * adds no prompt weight. Framed as OBSERVATIONS, not scoring criteria — mirrors
 * behavioralProxiesPromptBlock.
 */
export function journalLanguageHeatmapPromptBlock(entries: JournalEntry[]): string {
  const h = computeJournalHeatmap(entries)
  if (h.entryCount < MIN_ENTRIES || !h.hasSignal) return ''

  const lines: string[] = []

  if (h.phrases.length) {
    lines.push('Recurring words/phrases (across the trader\'s own journal):')
    for (const p of h.phrases) {
      const src = p.sources.map(s => SOURCE_LABEL[s]).join('/')
      lines.push(`  - "${p.phrase}" ×${p.count} (${src})${outcomeTint(p.winCount, p.lossCount, p.avgPnl)}`)
    }
  }

  if (h.emotions.length) {
    lines.push('Emotional language:')
    for (const e of h.emotions) {
      const src = e.sources.map(s => SOURCE_LABEL[s]).join('/')
      const eg = e.examples[0] ? `  e.g. "${e.examples[0].text}"` : ''
      lines.push(`  - ${e.label}: ${e.count} entries (${src})${outcomeTint(e.winCount, e.lossCount, e.avgPnl)}${eg}`)
    }
  }

  const directives: string[] = []
  if (h.uplift) directives.push(`⚑ UPLIFT: ${h.uplift.note}`)
  if (h.flag) directives.push(`⚑ FLAG: ${h.flag.note}`)

  return `TRADER LANGUAGE PATTERNS (recurring words/phrases + emotional language mined from the trader's OWN journal free-text — prep, trade notes, EOD, weekly — correlated to outcomes. OBSERVATIONS to react to in your coaching, NOT scoring criteria):
${lines.join('\n')}${directives.length ? '\n' + directives.join('\n') : ''}

`
}

// ── Async DB assembler ────────────────────────────────────────────────────────
export interface FetchJournalOptions {
  startDate: string   // YYYY-MM-DD inclusive
  endDate: string     // YYYY-MM-DD inclusive
  /** Already-fetched trades to reuse (coach-context has these in hand). Each
   *  needs id/trading_day_id/notes/pnl. When omitted, trades are queried. */
  trades?: Array<{ trading_day_id: string; notes?: string | null; pnl: number | null }>
}

/** Free-text fields on PrepNotes worth mining (concatenated per day). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prepNotesText(prep: any): string {
  if (!prep || typeof prep !== 'object') return ''
  const parts: string[] = []
  const push = (v: unknown) => { if (typeof v === 'string' && v.trim()) parts.push(v.trim()) }
  push(prep.bias_notes)
  push(prep.setups_areas)
  push(prep.volume_profile_notes)
  push(prep.mood)
  push(prep.market_clarity)
  if (Array.isArray(prep.trade_plans)) {
    for (const tp of prep.trade_plans) {
      push(tp?.setup_name); push(tp?.invalidation); push(tp?.targets); push(tp?.scary_factors)
      if (Array.isArray(tp?.quality_reasons)) tp.quality_reasons.forEach(push)
    }
  }
  return parts.join('. ')
}

/**
 * Fetch trader-authored free text across all four surfaces in [startDate,
 * endDate] and assemble JournalEntry[]. Best-effort: any failing source is
 * skipped (returns [] on total failure) so this never breaks the coach or EOD.
 *
 * Excludes ALL AI-generated text (ai_analysis_json / eod_ai_analysis_json /
 * ai_synthesis_json / recording_commentary) — only the trader's own words.
 */
export async function fetchJournalEntries(
  supabase: AnyClient,
  opts: FetchJournalOptions,
): Promise<JournalEntry[]> {
  const { startDate, endDate } = opts
  const entries: JournalEntry[] = []

  try {
    // ── trading_days: EOD + prep, plus the day-outcome/compliance map ─────────
    const { data: days } = await supabase
      .from('trading_days')
      .select('id, date, eod_notes, prep_notes_json, eod_pnl, eod_ai_analysis_json')
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true })

    const pnlByDayId = new Map<string, number | null>()
    const dateByDayId = new Map<string, string>()
    const pnlByDate = new Map<string, number | null>()
    const compliantByDate = new Map<string, boolean | null>()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const d of (days ?? []) as any[]) {
      const eod = d.eod_ai_analysis_json
      const verdict = eod?.process?.verdict
      const compliant = typeof verdict === 'string' ? /compliant/i.test(verdict) : null
      pnlByDayId.set(d.id, d.eod_pnl ?? null)
      dateByDayId.set(d.id, d.date)
      pnlByDate.set(d.date, d.eod_pnl ?? null)
      compliantByDate.set(d.date, compliant)

      if (typeof d.eod_notes === 'string' && d.eod_notes.trim()) {
        entries.push({ source: 'eod', date: d.date, text: d.eod_notes, pnl: d.eod_pnl ?? null, processCompliant: compliant })
      }
      const prepText = prepNotesText(d.prep_notes_json)
      if (prepText) {
        entries.push({ source: 'prep', date: d.date, text: prepText, pnl: d.eod_pnl ?? null, processCompliant: compliant })
      }
    }

    // ── daily_prep.notes (condition-lookup observation) ───────────────────────
    try {
      const { data: dp } = await supabase
        .from('daily_prep')
        .select('trade_date, notes')
        .gte('trade_date', startDate)
        .lte('trade_date', endDate)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (dp ?? []) as any[]) {
        if (typeof r.notes === 'string' && r.notes.trim()) {
          entries.push({
            source: 'prep', date: r.trade_date, text: r.notes,
            pnl: pnlByDate.get(r.trade_date) ?? null,
            processCompliant: compliantByDate.get(r.trade_date) ?? null,
          })
        }
      }
    } catch { /* best-effort */ }

    // ── trades.notes (per-trade → trade PnL) ──────────────────────────────────
    let tradeRows = opts.trades
    if (!tradeRows) {
      const dayIds = Array.from(pnlByDayId.keys())
      if (dayIds.length) {
        const collected: NonNullable<FetchJournalOptions['trades']> = []
        const PAGE = 1000
        for (let p = 0; p < 10; p++) {
          const { data } = await supabase
            .from('trades')
            .select('trading_day_id, notes, pnl')
            .in('trading_day_id', dayIds)
            .not('notes', 'is', null)
            .range(p * PAGE, p * PAGE + PAGE - 1)
          if (!data || data.length === 0) break
          collected.push(...data)
          if (data.length < PAGE) break
        }
        tradeRows = collected
      }
    }
    for (const t of tradeRows ?? []) {
      if (typeof t.notes === 'string' && t.notes.trim()) {
        const date = dateByDayId.get(t.trading_day_id) ?? startDate
        entries.push({ source: 'intraday', date, text: t.notes, pnl: t.pnl ?? null })
      }
    }

    // ── weekly_recap.notes_md (trader-authored) ───────────────────────────────
    try {
      const { data: wk } = await supabase
        .from('weekly_recap')
        .select('week_start_date, notes_md')
        .gte('week_start_date', startDate)
        .lte('week_start_date', endDate)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (wk ?? []) as any[]) {
        if (typeof r.notes_md === 'string' && r.notes_md.trim()) {
          entries.push({ source: 'weekly', date: r.week_start_date, text: r.notes_md, pnl: null })
        }
      }
    } catch { /* best-effort */ }
  } catch (e) {
    console.warn('[journal-heatmap] fetchJournalEntries failed:', e)
    return []
  }

  return entries
}
