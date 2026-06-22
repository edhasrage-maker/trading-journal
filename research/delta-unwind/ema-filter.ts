import { readFileSync, existsSync } from 'fs'
import { listNqContracts } from '../ema-slope/scid-discovery'
import { atrWilder } from '../ema-slope/atr'
import { isRTH } from '../ema-slope/aggregate'
import { emaSeries } from '../ema-slope/ema'
import { readScidDeltaBars, type DeltaBar } from './scid-delta'
import { buildEnvelope, signalSideAt, DEFAULT_PARAMS, type SignalParams } from './signal'

// Tests adding a "flip must follow the 1m 9 EMA direction" filter to the Delta
// Unwind signal: a long flip only counts when the 9 EMA is rising, a short flip
// only when it's falling (trend-aligned reversal). In ONE read pass it reports
// no-filter vs EMA-aligned vs EMA-counter, for two param sets, vs baseline.
//
// Metric: 1:1 ATR bracket-race win rate (param-independent per bar, so the gate
// only changes WHICH firing bars are counted, not their outcome).

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

type Args = {
  from: string | null
  to: string | null
  scidDir: string
  tfMin: number
  atrPeriod: number
  horizon: number
  bracketK: number
  filterEmaPeriod: number
  slopeLb: number // bars of lookback for the 9 EMA direction
  session: 'rth' | 'eth' | 'all'
}

function parseArgs(): Args {
  const a: Record<string, string> = {}
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i]
    const v = process.argv[i + 1]
    if (k.startsWith('--') && v !== undefined) a[k.slice(2)] = v
  }
  return {
    from: a.from ?? null,
    to: a.to ?? null,
    scidDir: a['scid-dir'] ?? process.env.SIERRA_DATA_DIR ?? 'D:\\SierraCharts\\Data',
    tfMin: Number(a.tf ?? 1),
    atrPeriod: Number(a.atr ?? 14),
    horizon: Number(a.horizon ?? 20),
    bracketK: Number(a.bracket ?? 1.0),
    filterEmaPeriod: Number(a['filter-ema'] ?? 9),
    slopeLb: Number(a['slope-lb'] ?? 3),
    session: (a.session ?? 'all') as Args['session'],
  }
}

function sessionOk(tsIso: string, session: Args['session']): boolean {
  if (session === 'all') return true
  const rth = isRTH(tsIso)
  return session === 'rth' ? rth : !rth
}

// Two study-param sets compared side by side.
const PARAM_SETS: Array<{ label: string; params: SignalParams }> = [
  { label: 'DEFAULT (str1.0/floor100/imp0.8)', params: { ...DEFAULT_PARAMS } },
  {
    label: 'CANDIDATE (str1.5/floor150/imp0.8)',
    params: { ...DEFAULT_PARAMS, unwindStrThresh: 1.5, minDeltaFloor: 150, maxDeltaFloor: 150 },
  },
]
type Variant = 'nofilter' | 'align' | 'counter'
const VARIANTS: Variant[] = ['nofilter', 'align', 'counter']

type Race = { win: number; loss: number; n: number }
const newRace = (): Race => ({ win: 0, loss: 0, n: 0 })
function wr(r: Race): number {
  const dec = r.win + r.loss
  return dec > 0 ? (100 * r.win) / dec : NaN
}
function addOutcome(r: Race, o: number) {
  r.n++
  if (o === 1) r.win++
  else if (o === 2) r.loss++
}
function raceOutcome(firstUp: number | null, firstDown: number | null, side: 'long' | 'short'): number {
  const fav = side === 'long' ? firstUp : firstDown
  const adv = side === 'long' ? firstDown : firstUp
  if (fav === null && adv === null) return 0
  if (adv === null) return 1
  if (fav === null) return 2
  return fav < adv ? 1 : 2
}
function fmtDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10) }

function main() {
  const args = parseArgs()
  console.log('args:', JSON.stringify(args))
  if (!existsSync(args.scidDir)) { console.error(`SCID dir not found: ${args.scidDir}`); process.exit(1) }
  const contracts = listNqContracts(args.scidDir)
  console.log(`Found ${contracts.length} NQ contracts`)
  if (contracts.length === 0) process.exit(1)

  const fromMs = args.from ? new Date(args.from + 'T00:00:00Z').getTime() : -Infinity
  const toMs = args.to ? new Date(args.to + 'T23:59:59.999Z').getTime() : Infinity
  const bucketMs = args.tfMin * 60_000
  const H = args.horizon

  const baseLong = newRace(), baseShort = newRace()
  // races[setIdx][variant].long/short
  const races = PARAM_SETS.map(() => ({
    nofilter: { long: newRace(), short: newRace() },
    align: { long: newRace(), short: newRace() },
    counter: { long: newRace(), short: newRace() },
  }))
  let totalBars = 0

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
    const atr = atrWilder(bars, args.atrPeriod)
    const env = buildEnvelope(bars, DEFAULT_PARAMS.emaLength)
    // 1m 9 EMA on close → direction at each bar (no lookahead: ema[i] uses close[i],
    // known at signal-bar close; entry is next bar open).
    const fe = emaSeries(bars.map(b => b.close), args.filterEmaPeriod)
    const lb = args.slopeLb

    const eligible = new Uint8Array(n)
    const longOut = new Int8Array(n)
    const shortOut = new Int8Array(n)
    const dir = new Int8Array(n) // 1 rising, -1 falling, 0 flat/unknown

    for (let i = 0; i < n - H - 1; i++) {
      const a = atr[i]
      if (!Number.isFinite(a) || a <= 0) continue
      if (!sessionOk(bars[i].ts, args.session)) continue
      const entry = bars[i + 1].open
      const upT = entry + args.bracketK * a
      const downT = entry - args.bracketK * a
      let firstUp: number | null = null
      let firstDown: number | null = null
      for (let step = 1; step <= H; step++) {
        const b = bars[i + step]
        if (firstUp === null && b.high >= upT) firstUp = step
        if (firstDown === null && b.low <= downT) firstDown = step
        if (firstUp !== null && firstDown !== null) break
      }
      eligible[i] = 1
      longOut[i] = raceOutcome(firstUp, firstDown, 'long')
      shortOut[i] = raceOutcome(firstUp, firstDown, 'short')
      if (i >= lb && Number.isFinite(fe[i]) && Number.isFinite(fe[i - lb])) {
        dir[i] = fe[i] > fe[i - lb] ? 1 : fe[i] < fe[i - lb] ? -1 : 0
      }
      addOutcome(baseLong, longOut[i])
      addOutcome(baseShort, shortOut[i])
    }

    for (let s = 0; s < PARAM_SETS.length; s++) {
      const p = PARAM_SETS[s].params
      const r = races[s]
      for (let i = 0; i < n - H - 1; i++) {
        if (!eligible[i]) continue
        const side = signalSideAt(i, bars, env, p)
        if (side !== 'long' && side !== 'short') continue
        const out = side === 'long' ? longOut[i] : shortOut[i]
        addOutcome(r.nofilter[side], out)
        const d = dir[i]
        const aligned = (side === 'long' && d > 0) || (side === 'short' && d < 0)
        const countered = (side === 'long' && d < 0) || (side === 'short' && d > 0)
        if (aligned) addOutcome(r.align[side], out)
        else if (countered) addOutcome(r.counter[side], out)
      }
    }
    totalBars += n
    console.log(`bars=${String(n).padStart(7)}`)
  }

  const bL = wr(baseLong), bS = wr(baseShort)
  console.log(`\nTotal ${args.tfMin}m bars: ${totalBars}   horizon ${H} bars   bracket ${args.bracketK}xATR`)
  console.log(`Filter: ${args.filterEmaPeriod} EMA direction, ${args.slopeLb}-bar slope lookback`)
  console.log(`Baseline race WR — long ${bL.toFixed(1)}%  short ${bS.toFixed(1)}%  (n=${baseLong.n})`)

  const row = (label: string, r: Race, base: number) => {
    const w = wr(r)
    const e = w - base
    console.log('  ' + label.padEnd(12) +
      (Number.isFinite(w) ? w.toFixed(1) + '%' : '—').padStart(8) +
      (Number.isFinite(e) ? (e >= 0 ? '+' : '') + e.toFixed(1) + 'pp' : '—').padStart(9) +
      String(r.n).padStart(9))
  }
  for (let s = 0; s < PARAM_SETS.length; s++) {
    const r = races[s]
    console.log(`\n=== ${PARAM_SETS[s].label} ===`)
    console.log('  LONG  (vs baseline ' + bL.toFixed(1) + '%)' + '   col: WR  edge  n')
    for (const v of VARIANTS) row(v, r[v].long, bL)
    console.log('  SHORT (vs baseline ' + bS.toFixed(1) + '%)')
    for (const v of VARIANTS) row(v, r[v].short, bS)
  }
}

main()
