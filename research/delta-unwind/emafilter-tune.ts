import { readFileSync, existsSync } from 'fs'
import { listNqContracts } from '../ema-slope/scid-discovery'
import { atrWilder } from '../ema-slope/atr'
import { isRTH } from '../ema-slope/aggregate'
import { emaSeries } from '../ema-slope/ema'
import { readScidDeltaBars, type DeltaBar } from './scid-delta'
import { buildEnvelope, signalSideAt, DEFAULT_PARAMS } from './signal'

// Robustness check for Run 3's counter-trend SHORT finding: does requiring the
// filter EMA to be RISING (fade strength) still lift the candidate short's race
// WR across different EMA periods and slope lookbacks? If the +6.3pp only shows
// at exactly 9-EMA / 3-bar, it's fragile. RTH-only, candidate params
// (short / str1.5 / floor150).

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

const PERIODS = (a.periods ?? '9,20,50').split(',').map(Number)
const LOOKBACKS = (a.lbs ?? '1,3,5,10').split(',').map(Number)

const CANDIDATE = { ...DEFAULT_PARAMS, unwindStrThresh: 1.5, minDeltaFloor: 150, maxDeltaFloor: 150 }

type Race = { win: number; loss: number; n: number }
const newRace = (): Race => ({ win: 0, loss: 0, n: 0 })
function wr(r: Race): number { const d = r.win + r.loss; return d > 0 ? (100 * r.win) / d : NaN }
function add(r: Race, o: number) { r.n++; if (o === 1) r.win++; else if (o === 2) r.loss++ }
function shortOutcome(firstUp: number | null, firstDown: number | null): number {
  // short: fav = down, adv = up; same bar → adverse (up) wins
  if (firstUp === null && firstDown === null) return 0
  if (firstUp === null) return 1
  if (firstDown === null) return 2
  return firstDown < firstUp ? 1 : 2
}
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function main() {
  if (!existsSync(SCID_DIR)) { console.error(`SCID dir not found: ${SCID_DIR}`); process.exit(1) }
  const contracts = listNqContracts(SCID_DIR)
  console.log(`Found ${contracts.length} NQ contracts. periods=${PERIODS}, lookbacks=${LOOKBACKS}`)
  if (contracts.length === 0) process.exit(1)

  const fromMs = FROM ? new Date(FROM + 'T00:00:00Z').getTime() : -Infinity
  const toMs = TO ? new Date(TO + 'T23:59:59.999Z').getTime() : Infinity
  const bucketMs = TF_MIN * 60_000

  const baseShort = newRace()
  const nofilter = newRace()
  // counter[period][lb], align[period][lb]
  const counter = PERIODS.map(() => LOOKBACKS.map(newRace))
  const align = PERIODS.map(() => LOOKBACKS.map(newRace))

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
    const closes = bars.map(b => b.close)
    const emas = PERIODS.map(p => emaSeries(closes, p))

    for (let i = 0; i < n - H - 1; i++) {
      const at = atr[i]
      if (!Number.isFinite(at) || at <= 0) continue
      if (!isRTH(bars[i].ts)) continue

      const entry = bars[i + 1].open
      const upT = entry + BRACKET_K * at
      const downT = entry - BRACKET_K * at
      let firstUp: number | null = null
      let firstDown: number | null = null
      for (let step = 1; step <= H; step++) {
        const b = bars[i + step]
        if (firstUp === null && b.high >= upT) firstUp = step
        if (firstDown === null && b.low <= downT) firstDown = step
        if (firstUp !== null && firstDown !== null) break
      }
      const out = shortOutcome(firstUp, firstDown)
      // Baseline = every eligible RTH bar as a hypothetical short.
      add(baseShort, out)
      // Everything below is conditioned on the candidate short actually firing.
      if (signalSideAt(i, bars, env, CANDIDATE) !== 'short') continue
      add(nofilter, out)

      for (let p = 0; p < PERIODS.length; p++) {
        const e = emas[p]
        for (let l = 0; l < LOOKBACKS.length; l++) {
          const lb = LOOKBACKS[l]
          if (i < lb || !Number.isFinite(e[i]) || !Number.isFinite(e[i - lb])) continue
          if (e[i] > e[i - lb]) add(counter[p][l], out)      // EMA rising → counter-trend short
          else if (e[i] < e[i - lb]) add(align[p][l], out)   // EMA falling → trend-aligned short
        }
      }
    }
    console.log(`bars=${String(n).padStart(7)}`)
  }

  const bS = wr(baseShort)
  console.log(`\nCandidate SHORT (str1.5/floor150), RTH, horizon ${H}, bracket ${BRACKET_K}xATR`)
  console.log(`Baseline short WR (all bars): ${bS.toFixed(1)}%`)
  console.log(`No-filter candidate short: ${wr(nofilter).toFixed(1)}%  (${(wr(nofilter) - bS >= 0 ? '+' : '')}${(wr(nofilter) - bS).toFixed(1)}pp, n=${nofilter.n})`)

  console.log(`\n=== COUNTER-trend short (filter EMA RISING) — WR / edge-vs-baseline / n ===`)
  const header = '  period   ' + LOOKBACKS.map(lb => `lb${lb}`.padStart(16)).join('')
  console.log(header)
  for (let p = 0; p < PERIODS.length; p++) {
    let line = `  EMA${String(PERIODS[p]).padEnd(6)}`
    for (let l = 0; l < LOOKBACKS.length; l++) {
      const r = counter[p][l]
      const w = wr(r), e = w - bS
      const cell = `${w.toFixed(1)}% ${(e >= 0 ? '+' : '')}${e.toFixed(1)} (${r.n})`
      line += cell.padStart(16)
    }
    console.log(line)
  }

  console.log(`\n=== ALIGN (filter EMA FALLING) — for contrast ===`)
  console.log(header)
  for (let p = 0; p < PERIODS.length; p++) {
    let line = `  EMA${String(PERIODS[p]).padEnd(6)}`
    for (let l = 0; l < LOOKBACKS.length; l++) {
      const r = align[p][l]
      const w = wr(r), e = w - bS
      const cell = `${w.toFixed(1)}% ${(e >= 0 ? '+' : '')}${e.toFixed(1)} (${r.n})`
      line += cell.padStart(16)
    }
    console.log(line)
  }
}

main()
