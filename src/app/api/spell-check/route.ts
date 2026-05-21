import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

const client = new Anthropic()

interface RequestBody {
  texts: Record<string, string>
}

export interface SpellCheckCorrection {
  key: string
  original: string
  corrected: string
  hasChanges: boolean
  notes?: string
}

interface ClaudeResponseEntry {
  key: string
  corrected: string
  notes?: string
}

export async function POST(req: Request) {
  const body = (await req.json()) as RequestBody
  const texts = body.texts ?? {}

  // Filter out empty fields
  const entries = Object.entries(texts).filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
  if (entries.length === 0) {
    return NextResponse.json({ corrections: [] })
  }

  const block = entries
    .map(([k, v]) => `[${k}]\n${v}`)
    .join('\n\n---\n\n')

  const prompt = `You are a careful proofreader for a trader's prep journal. Below are several text snippets, each preceded by [its-key].

═══ WHAT TO FIX ═══

1. **Misspelled real words** — e.g. "recieve" → "receive", "occured" → "occurred", "definately" → "definitely"
2. **Random letter sequences (gibberish)** — strings like "fdsf", "asdf", "qwer", "asdsa", "fjk", "sdsd", "qweqwe" are accidental keystrokes / placeholder text. REMOVE them entirely along with surrounding whitespace. The trader did not mean to type them.
3. **Grammar errors** — subject-verb agreement, wrong tense, missing articles
4. **Punctuation typos** — doubled punctuation, missing periods at end of sentences, stray commas
5. **Capitalisation** — start of sentences, proper nouns

═══ WHAT TO PRESERVE (NEVER CHANGE) ═══

- Trading symbols / contracts: NQ, MNQ, ES, MES, GC, MGC, CL, MCL, YM, RTY, ZB, ZN, 6E, 6B, etc.
- Standard trading abbreviations: RVOL, IB, IBH, IBL, PDH, PDL, ONH, ONL, MGI, VWAP, EMA, SMA, ATR, ADR, TPO, POC, HVN, LVN, R, R:R, BE, TP, SL, OR
- Numbers, prices, ratios, percentages
- Line breaks and paragraph structure
- The trader's voice, tone, informal language, and profanity (e.g. "feeling like shit today" stays as-is)
- Substantive content — only fix mechanical errors

═══ TYPO vs ABBREVIATION ═══

A short token is an abbreviation only if it appears in the preserve list above OR clearly relates to a trading concept (e.g. "FOMC", "CPI", "TPO"). Otherwise — if it's just random letters with no meaning — it's a typo and should be removed.

Examples:
- "felt good after the IB break" → unchanged ("IB" is preserved)
- "felt good after the fdsf break" → "felt good after the break" (fdsf removed)
- "needs follow thru" → "needs follow through" (real word typo fixed)
- "watch ONH for rejection" → unchanged ("ONH" is preserved)
- "watch zxcv for rejection" → "watch for rejection" (zxcv is gibberish, removed)
- "feeling like shit today fdsf sd" → "feeling like shit today" (profanity stays, gibberish removed)

═══ TASK ═══

For each snippet below, return the corrected version. If unchanged, return as-is. ALWAYS return every snippet.

Snippets:
${block}

Respond with ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "corrections": [
    { "key": "<the key>", "corrected": "<corrected text>", "notes": "<1-line summary of what changed, or omit if nothing changed>" }
  ]
}`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
  let parsed: { corrections?: ClaudeResponseEntry[] } = {}
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]) as { corrections?: ClaudeResponseEntry[] }
  } catch {
    return NextResponse.json({ corrections: [], error: 'Failed to parse AI response' }, { status: 500 })
  }

  // Build corrections list, ensuring every requested key is present
  const correctionsByKey = new Map<string, ClaudeResponseEntry>()
  for (const c of parsed.corrections ?? []) {
    if (c && typeof c.key === 'string') correctionsByKey.set(c.key, c)
  }

  const corrections: SpellCheckCorrection[] = entries.map(([key, original]) => {
    const c = correctionsByKey.get(key)
    const corrected = c?.corrected ?? original
    return {
      key,
      original,
      corrected,
      hasChanges: corrected.trim() !== original.trim(),
      notes: c?.notes,
    }
  })

  return NextResponse.json({ corrections })
}
