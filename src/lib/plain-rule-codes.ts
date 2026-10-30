/**
 * The coach writes its rails as codes — "P2 and P3 failed", "the size-up gate
 * (P2)". Detailed Tape keeps them (its rule chips name the same codes);
 * Highlights shows the coach's own lines with the codes said in words.
 *
 * Display only: the stored analysis and the prompt are untouched (prompt
 * changes are paused). A parenthetical code beside words that already name the
 * rule is dropped; a bare code becomes the rule's plain name.
 */

const NAMES: Record<string, string> = {
  P1: 'your daily loss limit',
  P2: 'your size cap',
  P3: 'no size-up after a loss',
  P4: 'your cooldown',
  P5: 'your trade cap',
}

const CODE = 'P[1-5]'
// "(P2)", "(P1, P3)", "(P2/P3)", "(P2 and P3)"
const PAREN = new RegExp(`\\s*\\(\\s*${CODE}(?:\\s*(?:,|/|&|and)\\s*${CODE})*\\s*\\)`, 'g')
const BARE = new RegExp(`\\b(${CODE})\\b`, 'g')

export function plainRuleCodes(text: string): string {
  const out = text
    .replace(PAREN, '')
    .replace(BARE, (_m, code: string) => NAMES[code] ?? code)
    .replace(/\s{2,}/g, ' ')
    .trim()
  // A sentence that now opens with "your …" / "no …" gets its capital back.
  return out.charAt(0).toUpperCase() + out.slice(1)
}
