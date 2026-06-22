import { readFileSync, existsSync } from 'fs'
import { listNqContracts } from '../ema-slope/scid-discovery'
import { atrWilder } from '../ema-slope/atr'
import { isRTH } from '../ema-slope/aggregate'
import { emaSeries } from '../ema-slope/ema'
import { readScidDeltaBars, type DeltaBar } from './scid-delta'
import { buildEnvelope, signalSideAt, DEFAULT_PARAMS } from './signal'

// Geometry breakdown of the candidate SHORT (str1.5/floor150): does the flip
// bar's POSITION relative to the 9 EMA matter, beyond the EMA's slope direction?
// 2 (slope: rising/falling) × 3 (location: bar above / straddles / below EMA).
//   above    = bar.low  > EMA   (whole bar above the line)
//   straddle = bar.low <= EMA <= bar.high   (TOUCHES the line)
//   below    = bar.high < EMA   (whole bar below the line)
// RTH, EMA9, slope lookback 3 (the tuned sweet spot). Metric: 1:1 ATR race WR.

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const a: Record<string, string> = {}
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = process.argv[i + 1]
  if (k.startsWith('--') && v !== undefined) a[k.slice(2)] = v
}
const SCID_DIR = a['scid-dir'] ?? process.env.SIERRA_DATA_DIR ?? 'D:\\SierraCharts\\Data'
const FROM = a.from ?? null
const TO = a.to ?? null
const TF_MIN = Number(a.tf ?? 1)
const ATR_PERIOD = Number(a.atr ?? 14)
const H = Number(a.horizon ?? 20)
const BRACKET_K = Number(a.bracket ?? 1.0)
const EMA_P = Number(a['filter-ema'] ?? 9)
const SLOPE_LB = Number(a['slope-lb'] ?? 3)

const CANDIDATE = { ...DEFAULT_PARAMS, unwindStrThresh: 1.5, minDeltaFloor: 150, maxDeltaFloor: 150 }

type Race = { win: number; loss: number; n: number }
const newRace = (): Race => ({ win: 0, loss: 0, n: 0 })
const wr = (r: Race) => { const d = r.win + r.loss; return d > 0 ? (100 * r.win) / d : NaN }
const add = (r: Race, o: number) => { r.n++; if (o === 1) r.win++; else if (o === 2) r.loss++ }
function merge(...rs: Race[]): Race {
  const o = newRace()
  for (const r of rs) { o.win += r.win; o.loss += r.loss; o.n += r.n }
  return o
}
function shortOutcome(firstUp: number | null, firstDown: number | null): number {
  if (firstUp === null && firstDown === null) return 0
  if (firstUp === null) return 1
  if (firstDown === null) return 2
  return firstDown < firstUp ? 1 : 2
}
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function main() {
  if (!existsSync(SCID_DIR)) { console.error(`SCID dir not found: ${SCID_DIR}`); process.exit(1) }
  const contracts = listNqContracts(SCID_DIR)
  console.log(`Found ${contracts.length} NQ contracts. EMA${EMA_P}, slope lb ${SLOPE_LB}`)
  if (contracts.length === 0) process.exit(1)

  const fromMs = FROM ? new Date(FROM + 'T00:00:00Z').getTime() : -Infinity
  const toMs = TO ? new Date(TO + 'T23:59:59.999Z').getTime() : Infinity
  const bucketMs = TF_MIN * 60_000

  const baseShort = newRace()
  const nofilter = newRace()
  // grid[slope 0=rising/1=falling][loc 0=above/1=straddle/2=below]
  const grid = [[newRace(), newRace(), newRace()], [newRace(), newRace(), newRace()]]

  for (const c of contracts) {
    const startMs = Math.max(c.activeStartMs, fromMs, c.fileFirstMs ?? -Infinity)
    const endMs = Math.min(c.activeEndMs, toMs, (c.fileLastMs ?? Infinity) + 1)
    if (startMs >= endMs) continue
    process.stdout.write(`  ${c.contract.padEnd(8)} ${fmtDate(startMs)} → ${fmtDate(endMs)}  `)
    const probe = readScidDeltaBars(c.path, startMs, startMs + 60 * 60 * 1000, { priceDivisor: 100, bucketMs })
    const priceDivisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
    const { bars }: { bars: DeltaBar[] } = readScidDeltaBars(c.path, startMs, endMs, { priceDivisor, bucketMs })
    if (bars.length === 0) { console.log('(no bars)'); continue }

    const n = bars.length
    const atr = atrWilder(bars, ATR_PERIOD)
    const env = buildEnvelope(bars, DEFAULT_PARAMS.emaLength)
    const ema = emaSeries(bars.map(b => b.close), EMA_P)

    for (let i = 0; i < n - H - 1; i++) {
      const at = atr[i]
      if (!Number.isFinite(at) || at <= 0) continue
      if (!isRTH(bars[i].ts)) continue
      const entry = bars[i + 1].open
      const upT = entry + BRACKET_K * at
      const downT = entry - BRACKET_K * at
      let firstUp: number | null = null, firstDown: number | null = null
      for (let step = 1; step <= H; step++) {
        const b = bars[i + step]
        if (firstUp === null && b.high >= upT) firstUp = step
        if (firstDown === null && b.low <= downT) firstDown = step
        if (firstUp !== null && firstDown !== null) break
      }
      const out = shortOutcome(firstUp, firstDown)
      add(baseShort, out)
      if (signalSideAt(i, bars, env, CANDIDATE) !== 'short') continue
      add(nofilter, out)

      if (i < SLOPE_LB || !Number.isFinite(ema[i]) || !Number.isFinite(ema[i - SLOPE_LB])) continue
      const slopeIdx = ema[i] > ema[i - SLOPE_LB] ? 0 : ema[i] < ema[i - SLOPE_LB] ? 1 : -1
      if (slopeIdx < 0) continue
      const b = bars[i]
      const locIdx = b.low > ema[i] ? 0 : b.high < ema[i] ? 2 : 1 // above / below / straddle
      add(grid[slopeIdx][locIdx], out)
    }
    console.log(`bars=${String(n).padStart(7)}`)
  }

  const bS = wr(baseShort)
  const cell = (r: Race) => {
    const w = wr(r), e = w - bS
    return (Number.isFinite(w) ? `${w.toFixed(1)}% ${(e >= 0 ? '+' : '')}${e.toFixed(1)} (${r.n})` : `— (0)`).padStart(18)
  }

  console.log(`\nCandidate SHORT (str1.5/floor150), RTH, EMA${EMA_P} slope-lb ${SLOPE_LB}, horizon ${H}, bracket ${BRACKET_K}xATR`)
  console.log(`Baseline short WR: ${bS.toFixed(1)}%   |   No-filter candidate short: ${cell(nofilter).trim()}`)
  console.log(`\nCells = race WR / edge-vs-baseline(pp) / n`)
  console.log('  ' + 'slope\\loc'.padEnd(10) + 'above-EMA'.padStart(18) + 'straddle(touch)'.padStart(18) + 'below-EMA'.padStart(18) + 'ALL (slope)'.padStart(18))
  const rowLabels = ['RISING', 'FALLING']
  for (let s = 0; s < 2; s++) {
    console.log('  ' + rowLabels[s].padEnd(10) +
      cell(grid[s][0]) + cell(grid[s][1]) + cell(grid[s][2]) + cell(merge(grid[s][0], grid[s][1], grid[s][2])))
  }
  console.log('  ' + 'ALL (loc)'.padEnd(10) +
    cell(merge(grid[0][0], grid[1][0])) +
    cell(merge(grid[0][1], grid[1][1])) +
    cell(merge(grid[0][2], grid[1][2])) +
    cell(merge(grid[0][0], grid[0][1], grid[0][2], grid[1][0], grid[1][1], grid[1][2])))
}

main()
