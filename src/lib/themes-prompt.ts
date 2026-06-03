/**
 * Prompt builder for /api/extract-themes.
 *
 * Kept in its own module so the prompt can be iterated on without touching
 * the route handler, and so the cache-version constant lives next to the
 * prompt body that defines its meaning. Bump PROMPT_VERSION whenever you
 * make a semantically meaningful change to the prompt — prior cached runs
 * stop matching, the next call regenerates, and the older rows stay in the
 * eod_themes_analysis table as historical reference.
 */

/** Cache key version. Bump on prompt changes that should invalidate prior runs. */
export const PROMPT_VERSION = 1

/** One day's worth of journal entry — the raw eod_notes field plus its date. */
export interface NoteEntry {
  date: string         // YYYY-MM-DD
  notes: string        // raw eod_notes content
}

/** Build the full text prompt for Claude given a corpus of dated notes. */
export function buildThemesPrompt(notes: NoteEntry[]): string {
  const corpus = notes
    .map(n => `=== ${n.date} ===\n${n.notes.trim()}`)
    .join('\n\n')

  return `You are reading a futures trader's daily end-of-day reflections, looking for recurring themes they keep returning to. Your job is to surface the patterns they may not consciously notice — the framings, complaints, and observations that show up over and over.

The trader writes in first-person, often informally — profanity is meaningful, preserve it in quoted excerpts. They use trader shorthand (e.g. "A+ S&D" = A-grade Supply & Demand setup, "DLL" = Daily Loss Limit, "IB" = Initial Balance, "VWAP", "EMA", "ONL/ONH"). These are vocabulary, not themes — don't surface them as patterns.

═══ WHAT COUNTS AS A THEME ═══
A theme is something the trader frames the same way across multiple days. Look for:
- Recurring framings of process vs outcome (e.g. "green P&L doesn't change that process was broken")
- Repeated emotional patterns (e.g. relief vs happiness, frustration when missing setups)
- Causal explanations they keep using ("got lucky", "broke a rule", "lost focus", "rushed the entry")
- Self-judgments (e.g. "undisciplined", "B-grade setup taken", "didn't trust the read")
- Concept they keep returning to (e.g. "trade my count down before the A+ shows up", "size up when I shouldn't have")

═══ WHAT DOESN'T COUNT ═══
- Single-day trade specifics ("bought NQ at 21450")
- Bare indicator/ticker vocabulary (RVOL, VWAP, ONH, etc. — these are nouns, not framings)
- A phrase that appears once or twice without pattern across the corpus

═══ OUTPUT REQUIREMENTS ═══
For each theme, provide:
- label: 3-6 word descriptive name written in the trader's voice (use their phrasing when it captures the theme well)
- summary: 1-2 sentences explaining the pattern, what causes it, and what it tends to lead to
- frequency_estimate: "high" (~15%+ of dated entries) | "medium" (~5-15%) | "low" (<5% but recurring)
- trend: "improving" (less frequent in newer entries) | "worsening" (more frequent in newer entries) | "steady" | "unclear"
- excerpts: 2-3 verbatim quotes pulled from the notes, each with its date. Pick the most evocative examples — these are what the trader will read when reviewing the theme.

Return between 5 and 10 themes. Skip themes that are too vague to be actionable ("trading is hard"). Prioritize ones with the most days of evidence and the clearest impact on the trader's process or results.

═══ NOTES CORPUS ═══
Below are ${notes.length} dated end-of-day reflections, sorted oldest first. Read them all before answering.

${corpus}

═══ RESPONSE ═══
Respond with ONLY a valid JSON object (no markdown, no code fences, no explanatory text before or after):
{
  "themes": [
    {
      "label": "<3-6 word theme name>",
      "summary": "<1-2 sentences>",
      "frequency_estimate": "high"|"medium"|"low",
      "trend": "improving"|"worsening"|"steady"|"unclear",
      "excerpts": [
        { "date": "YYYY-MM-DD", "text": "<verbatim quote>" },
        { "date": "YYYY-MM-DD", "text": "<verbatim quote>" }
      ]
    }
  ]
}`
}

/** Shape Claude returns. */
export interface ThemesResponse {
  themes: ThemeRaw[]
}

export interface ThemeRaw {
  label: string
  summary: string
  frequency_estimate: 'high' | 'medium' | 'low'
  trend: 'improving' | 'worsening' | 'steady' | 'unclear'
  excerpts: Array<{ date: string; text: string }>
}

/** Enrich a raw theme with grade/PnL correlations derived from its excerpt dates. */
export interface EnrichedTheme extends ThemeRaw {
  /** Unique excerpt dates Claude quoted from. Subset of all evidence days. */
  evidence_dates: string[]
  /** Mean overall_grade across evidence_dates (excludes nulls). */
  avg_grade: number | null
  /** Mean eod_pnl across evidence_dates (excludes nulls). */
  avg_pnl: number | null
  /** Mean process_score across evidence_dates (excludes nulls). */
  avg_process_score: number | null
}
