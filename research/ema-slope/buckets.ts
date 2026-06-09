// Bucket a slope value into a labeled [lower, upper) bin of width `size`.
// Used for grouping trades by slope so we can compute per-bucket stats.
export function bucketLabel(value: number, size: number): string {
  const lower = Math.floor(value / size) * size
  const upper = lower + size
  return `${fmt(lower)} → ${fmt(upper)}`
}

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100
  return (r >= 0 ? '+' : '') + r.toString()
}

// Parses the lower bound back out of a label produced by `bucketLabel`.
// Used to sort the aggregated rows numerically rather than alphabetically.
export function parseLower(label: string): number {
  return parseFloat(label.split('→')[0].trim().replace('+', ''))
}
