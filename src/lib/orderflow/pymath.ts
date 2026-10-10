/**
 * Python / numpy numeric semantics the order-flow reference relies on.
 *
 * The reference implementation (the blind re-tag server) is Python, and a few
 * of its results hinge on rounding rules JavaScript doesn't share:
 *   - Python's round() and numpy's round/rint resolve an exact .5 to the EVEN
 *     neighbour; Math.round and toFixed() resolve it upward.
 *   - np.percentile's default 'linear' method interpolates with an asymmetric
 *     lerp that a naive a + (b - a) * t does not reproduce bit for bit.
 * Ties are real here, not theoretical: an ATR is a mean of quarter-point true
 * ranges over 14 bars, so stop = entry - ATR lands exactly between two ticks
 * about one time in fourteen.
 */

const F64 = new Float64Array(1)
const U32 = new Uint32Array(F64.buffer)
// BigInt() calls, not literals: the app compiles to ES2017.
const B1 = BigInt(1), B2 = BigInt(2), B10 = BigInt(10), B32 = BigInt(32), B52 = BigInt(52)

/** Exact decomposition of a finite, non-zero double: |x| = mant * 2^exp. */
function decompose(x: number): { neg: boolean; mant: bigint; exp: number } {
  F64[0] = x
  const lo = U32[0], hi = U32[1]
  const neg = (hi >>> 31) === 1
  const bexp = (hi >>> 20) & 0x7ff
  const frac = (BigInt(hi & 0xfffff) << B32) | BigInt(lo)
  return bexp === 0
    ? { neg, mant: frac, exp: -1074 }                       // subnormal
    : { neg, mant: frac | (B1 << B52), exp: bexp - 1075 }
}

/**
 * Python's round(x, nd): the exact binary value rounded to `nd` decimals with
 * ties to even, returned as the nearest double. nd = 0 is also numpy's
 * np.round / np.rint for float64.
 */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x) || x === 0) return x
  const s = 10 ** nd
  const y = x * s
  // Already on the grid (prices, volumes): the scaled value is an integer k and
  // Python returns the double nearest k / 10^nd, which is exactly y / s.
  if (Number.isInteger(y) && Math.abs(y) < 2 ** 52) return y / s
  // Not near a tie: toFixed() is correctly rounded on the exact binary value.
  const frac = y - Math.floor(y)
  if (Math.abs(frac - 0.5) > 1e-6) return Number(x.toFixed(nd))
  // Possible exact tie: settle it on the exact binary value, ties to even.
  const scale = B10 ** BigInt(nd)
  const { neg, mant, exp } = decompose(x)
  if (exp >= 0) return x                                     // already an integer
  const num = mant * scale
  const den = B1 << BigInt(-exp)
  let q = num / den
  const r2 = B2 * (num % den)
  if (r2 > den || (r2 === den && (q & B1) === B1)) q += B1
  const out = Number(q) / Number(scale)
  return neg ? -out : out
}

/** numpy's np.round(x) / np.rint(x): ties to even. Fast path for hot loops. */
export function rint(x: number): number {
  const r = Math.round(x)                      // ties toward +inf
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** Python's math.ceil (identical to Math.ceil for finite doubles). */
export const pyCeil = Math.ceil

/**
 * np.percentile(values, q) with numpy 2.x's default method ('linear'), for a
 * 1-D float64 sample. Copies; does not mutate `values`.
 */
export function npPercentileLinear(values: ArrayLike<number>, q: number): number {
  const n = values.length
  if (n === 0) return NaN
  const a = Float64Array.from(values).sort()
  const quant = q / 100
  const virt = (n - 1) * quant
  if (virt >= n - 1) return a[n - 1]
  if (virt < 0) return a[0]
  const prev = Math.floor(virt)
  const lo = a[prev], hi = a[prev + 1]
  const gamma = virt - prev
  const diff = hi - lo
  return gamma >= 0.5 ? hi - diff * (1 - gamma) : lo + diff * gamma
}
