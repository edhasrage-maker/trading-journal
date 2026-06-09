import { parseLower } from './buckets'

export type Aggregate = {
  bucket: string
  count: number
  wins: number
  losses: number
  winRate: number
  totalPnL: number
  avgPnL: number
  avgWin: number
  avgLoss: number
  ev: number
}

export function aggregate(
  rows: Array<{ bucket: string; pnl: number }>,
): Aggregate[] {
  const byBucket = new Map<string, number[]>()
  for (const r of rows) {
    if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, [])
    byBucket.get(r.bucket)!.push(r.pnl)
  }
  const out: Aggregate[] = []
  for (const [bucket, pnls] of byBucket) {
    const wins = pnls.filter(p => p > 0)
    const losses = pnls.filter(p => p <= 0)
    const totalPnL = pnls.reduce((a, b) => a + b, 0)
    const avgPnL = totalPnL / pnls.length
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
    out.push({
      bucket,
      count: pnls.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / pnls.length,
      totalPnL,
      avgPnL,
      avgWin,
      avgLoss,
      ev: avgPnL,
    })
  }
  return out.sort((a, b) => parseLower(a.bucket) - parseLower(b.bucket))
}
