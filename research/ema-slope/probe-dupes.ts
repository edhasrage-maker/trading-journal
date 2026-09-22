import { makeTickReader } from '../../src/lib/scid-reader'

// Compare the Jun-25 duplicate files against their legacy twins: same window, raw prices.
const PAIRS: Array<{ a: string; b: string; when: string }> = [
  { a: 'NQz5.CME.scid', b: 'NQZ25-CME.scid', when: '2025-10-15T10:00:00-07:00' },
  { a: 'NQH6.CME.scid', b: 'NQH26-CME.scid', when: '2026-01-15T10:00:00-08:00' },
]
const dir = 'D:\\SierraCharts\\Data\\'

for (const { a, b, when } of PAIRS) {
  const t0 = new Date(when).getTime()
  for (const f of [a, b]) {
    try {
      const tr = makeTickReader(dir + f, 1) // divisor 1 → RAW stored values
      const ticks = tr.read(t0, t0 + 60_000)
      tr.close()
      const head = ticks.slice(0, 3).map(p => p.toFixed(0)).join(' ')
      console.log(`${f.padEnd(18)} @ ${when}: ${ticks.length} ticks, first: ${head || '(none)'}`)
    } catch (e) {
      console.log(`${f.padEnd(18)} ERROR: ${(e as Error).message}`)
    }
  }
}
