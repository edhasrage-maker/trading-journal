import { makeTickReader } from '../../src/lib/scid-reader'

// Do the legacy single-file quarters still carry 0.25-tick granularity, or were
// they rounded in place? Sample raw stored values and bucket by last-2-digits (×100 scale).
const FILES: Array<{ f: string; when: string }> = [
  { f: 'NQH2.CME.scid', when: '2022-01-18T08:00:00-08:00' },
  { f: 'NQM25-CME.scid', when: '2025-04-15T08:00:00-07:00' },
  { f: 'NQM5.CME.scid', when: '2025-04-15T08:00:00-07:00' },
  { f: 'NQU6.CME.scid', when: '2026-06-16T08:00:00-07:00' },
]
const dir = 'D:\\SierraCharts\\Data\\'

for (const { f, when } of FILES) {
  const t0 = new Date(when).getTime()
  try {
    const tr = makeTickReader(dir + f, 1)
    const ticks = tr.read(t0, t0 + 10 * 60_000)
    tr.close()
    if (ticks.length === 0) { console.log(`${f.padEnd(18)} (no ticks in window)`); continue }
    const cents = new Map<number, number>()
    for (const p of ticks) { const c = Math.round(p) % 100; cents.set(c, (cents.get(c) ?? 0) + 1) }
    const dist = [...cents.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)
      .map(([c, n]) => `${String(c).padStart(2, '0')}:${n}`).join(' ')
    console.log(`${f.padEnd(18)} ${ticks.length} ticks  first=${ticks[0]}  last2dig → ${dist}`)
  } catch (e) {
    console.log(`${f.padEnd(18)} ERROR: ${(e as Error).message.split('\n')[0]}`)
  }
}
