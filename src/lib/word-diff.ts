/**
 * Minimal word-level diff using LCS.
 * Used by the spell-check modal to show what's being added (green) and removed
 * (red) within each correction.
 */

export interface DiffOp {
  type: 'eq' | 'ins' | 'del'
  text: string
}

/**
 * Tokenise into a sequence of (word | whitespace) tokens. Splitting this way
 * preserves the original whitespace exactly when reassembled.
 */
function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter(t => t.length > 0)
}

export function wordDiff(a: string, b: string): DiffOp[] {
  const aTokens = tokenize(a)
  const bTokens = tokenize(b)
  const m = aTokens.length
  const n = bTokens.length

  // LCS DP table
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aTokens[i - 1] === bTokens[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1])
      }
    }
  }

  // Backtrack to build the op sequence
  const ops: DiffOp[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (aTokens[i - 1] === bTokens[j - 1]) {
      ops.unshift({ type: 'eq', text: aTokens[i - 1] })
      i--
      j--
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      ops.unshift({ type: 'del', text: aTokens[i - 1] })
      i--
    } else {
      ops.unshift({ type: 'ins', text: bTokens[j - 1] })
      j--
    }
  }
  while (i > 0) {
    ops.unshift({ type: 'del', text: aTokens[i - 1] })
    i--
  }
  while (j > 0) {
    ops.unshift({ type: 'ins', text: bTokens[j - 1] })
    j--
  }

  // Coalesce adjacent ops of the same type for cleaner rendering
  const merged: DiffOp[] = []
  for (const op of ops) {
    const last = merged[merged.length - 1]
    if (last && last.type === op.type) {
      last.text += op.text
    } else {
      merged.push({ ...op })
    }
  }
  return merged
}
