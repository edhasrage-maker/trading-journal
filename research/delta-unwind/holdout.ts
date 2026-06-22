import { readFileSync, existsSync } from 'fs'
import { listNqContracts } from '../ema-slope/scid-discovery'
import { atrWilder } from '../ema-slope/atr'
import { isRTH, ptDateKey } from '../ema-slope/aggregate'
import { emaSeries } from '../ema-slope/ema'
import { readScidDeltaBars, type DeltaBar } from './scid-delta'
import { buildEnvelope, signalSideAt, DEFAULT_PARAMS } from './signal'

// DECISIVE TEST — fit vs holdout, real trade model.
//
// Locked rule (from Runs 1–5, no further slicing):
//   SHORT · str1.5 · floor150 · flip bar ENTIRELY ABOVE a RISING 9 EMA (lb3)
//
// Trade model: enter next 1m bar's open, ATR stop, fixed-R target, force-flatten
// at end of RTH session (no overnight). Same-bar stop+target → stop (conservative).
// Reports avg R / win% / profit factor / total R / trades/day, FIT (2022–24) vs
// HOLDOUT (2025–26), across a stop×target grid so we see if ANY sensible exit
// works out-of-sample — not just one cherry-picked pair.

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
const TF_MIN = Number(a.tf ?? 1)
const ATR_PERIOD = Number(a.atr ?? 14)
const EMA_P = Number(a['filter-ema'] ?? 9)
const SLOPE_LB = Number(a['slope-lb'] ?? 3)
const FIT_YEARS = new Set([2022, 2023, 2024])
const HOLD_YEARS = new Set([2025, 2026])
const STOP_GRID = (a.stops ?? '1.0,1.5').split(',').map(Number)
const TARGET_GRID = (a.targets ?? '1.5,2,3').split(',').map(Number)

const CANDIDATE = { ...DEFAULT_PARAMS, unwindStrThresh: 1.5, minDeltaFloor: 150, maxDeltaFloor: 150 }
const NQ_POINT = 20 // $/point, 1 contract — for color only

// A fired signal, resolved once; the trade model is applied per (stop,target).
type Sig = { entryIdx: number; atr: number; year: number }

type Stat = { n: number; wins: number; sumR: number; pos: number; neg: number; days: Set<string> }
const newStat = (): Stat => ({ n: 0, wins: 0, sumR: 0, pos: 0, neg: 0, days: new Set() })
function addTrade(s: Stat, R: number, day: string) {
  s.n++; s.sumR += R; if (R > 0) { s.wins++; s.pos += R } else s.neg += R
  s.days.add(day)
}

// Short trade: enter at entry, stop above, target below; walk forward within the
// same RTH session; force-flatten at the last in-session bar's close.
function simulateShort(
  bars: DeltaBar[], isRth: boolean[], day: string[], entryIdx: number,
  atr: number, stopAtr: number, targetR: number,
): number | null {
  if (entryIdx >= bars.length || !isRth[entryIdx]) return null // no bar to enter on
  const entry = bars[entryIdx].open
  const stopDist = stopAtr * atr
  if (!(stopDist > 0)) return null
  const stop = entry + stopDist
  const target = entry - stopDist * targetR
  const d0 = day[entryIdx]
  let lastClose = entry
  for (let j = entryIdx; j < bars.length && isRth[j] && day[j] === d0; j++) {
    const b = bars[j]
    lastClose = b.close
    if (b.high >= stop) return -1 // stop first (conservative on same-bar)
    if (b.low <= target) return targetR
  }
  return (entry - lastClose) / stopDist // time-stop at session close
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function main() {
  if (!existsSync(SCID_DIR)) { console.error(`SCID dir not found: ${SCID_DIR}`); process.exit(1) }
  const contracts = listNqContracts(SCID_DIR)
  console.log(`Found ${contracts.length} NQ contracts`)
  console.log(`Rule: SHORT · str1.5 · floor150 · bar above RISING EMA${EMA_P} (lb${SLOPE_LB})`)
  console.log(`Stops(ATR): ${STOP_GRID}   Targets(R): ${TARGET_GRID}`)
  if (contracts.length === 0) process.exit(1)

  const bucketMs = TF_MIN * 60_000
  // stats[stopIdx][targetIdx][window 0=fit/1=hold]
  const stats = STOP_GRID.map(() => TARGET_GRID.map(() => [newStat(), newStat()]))
  let totalSignals = 0

  for (const c of contracts) {
    const startMs = Math.max(c.activeStartMs, c.fileFirstMs ?? -Infinity)
    const endMs = Math.min(c.activeEndMs, (c.fileLastMs ?? Infinity) + 1)
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
    const isRth = bars.map(b => isRTH(b.ts))
    const day = bars.map(b => ptDateKey(b.ts))

    const sigs: Sig[] = []
    for (let i = 0; i < n - 1; i++) {
      if (!isRth[i]) continue
      const at = atr[i]
      if (!Number.isFinite(at) || at <= 0) continue
      if (i < SLOPE_LB || !Number.isFinite(ema[i]) || !Number.isFinite(ema[i - SLOPE_LB])) continue
      if (!(ema[i] > ema[i - SLOPE_LB])) continue          // rising 9 EMA
      if (!(bars[i].low > ema[i])) continue                // bar entirely above EMA
      if (signalSideAt(i, bars, env, CANDIDATE) !== 'short') continue
      const yr = parseInt(day[i].slice(0, 4), 10)
      sigs.push({ entryIdx: i + 1, atr: at, year: yr })
    }
    totalSignals += sigs.length

    for (let s = 0; s < STOP_GRID.length; s++) {
      for (let t = 0; t < TARGET_GRID.length; t++) {
        for (const sig of sigs) {
          const w = FIT_YEARS.has(sig.year) ? 0 : HOLD_YEARS.has(sig.year) ? 1 : -1
          if (w < 0) continue
          const R = simulateShort(bars, isRth, day, sig.entryIdx, sig.atr, STOP_GRID[s], TARGET_GRID[t])
          if (R === null) continue
          addTrade(stats[s][t][w], R, day[sig.entryIdx])
        }
      }
    }
    console.log(`bars=${String(n).padStart(7)}  signals=${String(sigs.length).padStart(4)}`)
  }

  console.log(`\nTotal raw signals: ${totalSignals}`)
  const fmtStat = (st: Stat, stopDistMeanNote = '') => {
    if (st.n === 0) return 'n=0'
    const wr = (100 * st.wins / st.n).toFixed(1)
    const avgR = (st.sumR / st.n).toFixed(3)
    const pf = st.neg < 0 ? (st.pos / -st.neg).toFixed(2) : '∞'
    const tpd = (st.n / Math.max(1, st.days.size)).toFixed(2)
    return `n=${String(st.n).padStart(4)}  WR=${wr.padStart(5)}%  avgR=${avgR.padStart(7)}  PF=${pf.padStart(5)}  totR=${st.sumR.toFixed(1).padStart(7)}  t/day=${tpd}${stopDistMeanNote}`
  }

  console.log('\n══════════════════════════ FIT (2022–2024) vs HOLDOUT (2025–2026) ══════════════════════════')
  for (let s = 0; s < STOP_GRID.length; s++) {
    for (let t = 0; t < TARGET_GRID.length; t++) {
      const fit = stats[s][t][0], hold = stats[s][t][1]
      console.log(`\nstop ${STOP_GRID[s]}xATR / target ${TARGET_GRID[t]}R`)
      console.log(`  FIT    ${fmtStat(fit)}`)
      console.log(`  HOLD   ${fmtStat(hold)}`)
    }
  }

  console.log('\nPASS CRITERIA: positive avgR (expectancy) on HOLDOUT across MOST stop/target combos.')
  console.log(`(avg R is per-trade in stop-distance units; $ at 1 NQ contract ≈ avgR × stopDist × ${NQ_POINT}.)`)
}

main()
