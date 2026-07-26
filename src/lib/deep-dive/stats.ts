// Small deterministic stats shared by the deep-dive modules. Deliberately tiny
// and dependency-free so every dive stays PURE + unit-testable.
//
// The significance bar matches src/lib/data-insights.ts (two-sided 95%) so a
// claim a dive makes and a claim the contrast engine makes are held to the same
// standard. A dive is allowed to SHOW a weak decomposition — it just can't
// propose a falsifiable test off one.

/** Two-sided 95%. Same bar as data-insights INSIGHT_Z_MIN. */
export const DIVE_Z_MIN = 1.96
/** One-sided-ish bar for "propose the trim" style tests, where the direction is
 *  pre-specified by the decomposition (we only ever propose cutting a region
 *  that is ALREADY negative, so the sign isn't being fished for). */
export const DIVE_Z_MIN_DIRECTIONAL = 1.64

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** Sample variance (n−1). 0 for n < 2. */
export function variance(xs: number[], m = mean(xs)): number {
  if (xs.length < 2) return 0
  return xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1)
}

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Percentile (0..1) by nearest-rank on the sorted sample. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))
  return s[i]
}

/** Welch two-sample z on the means (a − b). 0 when either side is too small or
 *  has no spread — callers treat 0 as "not significant". */
export function welchZ(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length)
  if (!(se > 0)) return 0
  const z = (mean(a) - mean(b)) / se
  return Number.isFinite(z) ? z : 0
}

/** Share of `xs` that are > 0. */
export function shareAbove(xs: number[], threshold = 0): number {
  if (!xs.length) return 0
  return xs.filter(x => x > threshold).length / xs.length
}
