import { readFileSync, existsSync } from 'fs'
import { listNqContracts } from '../ema-slope/scid-discovery'
import { atrWilder } from '../ema-slope/atr'
import { isRTH } from '../ema-slope/aggregate'
import { readScidDeltaBars, type DeltaBar } from './scid-delta'
import { computeSignals, DEFAULT_PARAMS, type SignalParams } from './signal'

// Optional .env.local load (kept for parity with the rest of research/; this
// runner is .scid-only and does not require Supabase).
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
  session: 'rth' | 'eth' | 'all'
  horizons: number[] // forward window sizes in TF bars
  bracketK: number // race bracket half-width in ATR
  params: SignalParams
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
    session: (a.session ?? 'rth') as Args['session'],
    horizons: (a.horizons ?? '5,10,20').split(',').map(s => Number(s.trim())).filter(n => n > 0).sort((x, y) => x - y),
    bracketK: Number(a.bracket ?? 1.0),
    params: {
      emaLength: Number(a.ema ?? DEFAULT_PARAMS.emaLength),
      minDeltaFloor: Number(a['floor-min'] ?? DEFAULT_PARAMS.minDeltaFloor),
      maxDeltaFloor: Number(a['floor-max'] ?? DEFAULT_PARAMS.maxDeltaFloor),
      impulseMult: Number(a.imp ?? DEFAULT_PARAMS.impulseMult),
      unwindStrThresh: Number(a.str ?? DEFAULT_PARAMS.unwindStrThresh),
      requireLongCloseGE0: (a['long-ge0'] ?? '1') === '1',
      shortCloseMode: (Number(a['short-mode'] ?? DEFAULT_PARAMS.shortCloseMode) as 0 | 1 | 2),
      shortCloseFrac: Number(a['short-frac'] ?? DEFAULT_PARAMS.shortCloseFrac),
    },
  }
}

// Fixed-resolution histogram for ATR-normalized excursions. Bounds memory so the
// run scales to millions of baseline bars; median via cumulative-count scan.
class Hist {
  private bins: Float64Array
  private readonly binW: number
  private readonly maxBins: number
  n = 0
  sum = 0
  constructor(binW = 0.05, maxVal = 40) {
    this.binW = binW
    this.maxBins = Math.ceil(maxVal / binW) + 1
    this.bins = new Float64Array(this.maxBins)
  }
  push(v: number) {
    if (!Number.isFinite(v)) return
    this.n++
    this.sum += v
    let idx = Math.floor((v < 0 ? 0 : v) / this.binW)
    if (idx < 0) idx = 0
    if (idx >= this.maxBins) idx = this.maxBins - 1
    this.bins[idx]++
  }
  quantile(q: number): number {
    if (this.n === 0) return NaN
    const target = q * this.n
    let cum = 0
    for (let i = 0; i < this.maxBins; i++) {
      cum += this.bins[i]
      if (cum >= target) return (i + 0.5) * this.binW
    }
    return (this.maxBins - 0.5) * this.binW
  }
  mean(): number { return this.n ? this.sum / this.n : NaN }
}

type Race = { win: number; loss: number; neither: number }
type Group = { mfe: Hist[]; mae: Hist[]; race: Race; n: number }

function newGroup(nHorizons: number): Group {
  return {
    mfe: Array.from({ length: nHorizons }, () => new Hist()),
    mae: Array.from({ length: nHorizons }, () => new Hist()),
    race: { win: 0, loss: 0, neither: 0 },
    n: 0,
  }
}

function sessionOk(tsIso: string, session: Args['session']): boolean {
  if (session === 'all') return true
  const rth = isRTH(tsIso)
  return session === 'rth' ? rth : !rth
}

// Walk one contract's contiguous bar series, folding each eligible bar into the
// baseline groups and (when it fired) the matching signal group.
function processBars(
  bars: DeltaBar[],
  args: Args,
  groups: { baseLong: Group; baseShort: Group; sigLong: Group; sigShort: Group },
) {
  const n = bars.length
  const maxH = args.horizons[args.horizons.length - 1]
  if (n < args.atrPeriod + maxH + 2) return

  const atr = atrWilder(bars, args.atrPeriod)
  const signals = computeSignals(bars, args.params)

  for (let i = 0; i < n - maxH - 1; i++) {
    const a = atr[i]
    if (!Number.isFinite(a) || a <= 0) continue
    if (!sessionOk(bars[i].ts, args.session)) continue

    const entry = bars[i + 1].open
    const upT = entry + args.bracketK * a
    const downT = entry - args.bracketK * a

    let hi = -Infinity
    let lo = Infinity
    let hPtr = 0
    let firstUp: number | null = null
    let firstDown: number | null = null

    // Per-horizon excursions (long & short framing) + first-touch race indices.
    const longMfe: number[] = new Array(args.horizons.length)
    const longMae: number[] = new Array(args.horizons.length)
    const shortMfe: number[] = new Array(args.horizons.length)
    const shortMae: number[] = new Array(args.horizons.length)

    for (let step = 1; step <= maxH; step++) {
      const b = bars[i + step]
      if (b.high > hi) hi = b.high
      if (b.low < lo) lo = b.low
      if (firstUp === null && b.high >= upT) firstUp = step
      if (firstDown === null && b.low <= downT) firstDown = step
      if (hPtr < args.horizons.length && step === args.horizons[hPtr]) {
        longMfe[hPtr] = (hi - entry) / a
        longMae[hPtr] = (entry - lo) / a
        shortMfe[hPtr] = (entry - lo) / a
        shortMae[hPtr] = (hi - entry) / a
        hPtr++
      }
    }

    // Bracket race outcomes (1:1-style, half-width = bracketK ATR). Same-bar
    // double-touch resolves to the adverse side (conservative).
    const longOutcome = raceOutcome(firstUp, firstDown, 'long')
    const shortOutcome = raceOutcome(firstUp, firstDown, 'short')

    foldExcursion(groups.baseLong, longMfe, longMae, longOutcome)
    foldExcursion(groups.baseShort, shortMfe, shortMae, shortOutcome)

    const side = signals[i].side
    if (side === 'long') foldExcursion(groups.sigLong, longMfe, longMae, longOutcome)
    else if (side === 'short') foldExcursion(groups.sigShort, shortMfe, shortMae, shortOutcome)
  }
}

function raceOutcome(firstUp: number | null, firstDown: number | null, side: 'long' | 'short'): keyof Race {
  // For long: favorable = up, adverse = down. For short: favorable = down, adverse = up.
  const fav = side === 'long' ? firstUp : firstDown
  const adv = side === 'long' ? firstDown : firstUp
  if (fav === null && adv === null) return 'neither'
  if (adv === null) return 'win'
  if (fav === null) return 'loss'
  if (fav < adv) return 'win'
  return 'loss' // fav > adv, or same bar (adverse wins)
}

function foldExcursion(g: Group, mfe: number[], mae: number[], outcome: keyof Race) {
  g.n++
  for (let h = 0; h < mfe.length; h++) {
    g.mfe[h].push(mfe[h])
    g.mae[h].push(mae[h])
  }
  g.race[outcome]++
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function pad(s: string | number, w: number): string {
  return String(s).padStart(w)
}

function printSide(
  label: string,
  sig: Group,
  base: Group,
  horizons: number[],
  tfMin: number,
) {
  console.log(`\n=== ${label}  (signals: ${sig.n}, baseline bars: ${base.n}) ===`)
  if (sig.n === 0) { console.log('  (no signals)'); return }
  console.log(
    '  ' +
    'horizon'.padEnd(10) +
    pad('medMFE', 9) + pad('medMAE', 9) + pad('MFE/MAE', 9) +
    pad('baseMFE', 9) + pad('baseMAE', 9) + pad('lift', 8),
  )
  for (let h = 0; h < horizons.length; h++) {
    const sMfe = sig.mfe[h].quantile(0.5)
    const sMae = sig.mae[h].quantile(0.5)
    const bMfe = base.mfe[h].quantile(0.5)
    const bMae = base.mae[h].quantile(0.5)
    const ratio = sMae > 0 ? sMfe / sMae : NaN
    const lift = sMfe - bMfe
    console.log(
      '  ' +
      `${horizons[h]}b/${horizons[h] * tfMin}m`.padEnd(10) +
      pad(sMfe.toFixed(2), 9) + pad(sMae.toFixed(2), 9) + pad(ratio.toFixed(2), 9) +
      pad(bMfe.toFixed(2), 9) + pad(bMae.toFixed(2), 9) +
      pad((lift >= 0 ? '+' : '') + lift.toFixed(2), 8),
    )
  }
  const wr = (r: Race) => {
    const dec = r.win + r.loss
    return dec > 0 ? (100 * r.win / dec) : NaN
  }
  const sigWr = wr(sig.race)
  const baseWr = wr(base.race)
  console.log(
    `  bracket race  signal WR ${sigWr.toFixed(1)}% (W${sig.race.win}/L${sig.race.loss}/—${sig.race.neither})` +
    `   baseline WR ${baseWr.toFixed(1)}%   edge ${(sigWr - baseWr >= 0 ? '+' : '')}${(sigWr - baseWr).toFixed(1)}pp`,
  )
}

async function main() {
  const args = parseArgs()
  console.log('args:', JSON.stringify({ ...args, params: undefined }), '\nparams:', args.params)

  if (!existsSync(args.scidDir)) {
    console.error(`SCID dir not found: ${args.scidDir}`)
    console.error('Set SIERRA_DATA_DIR in .env.local or pass --scid-dir')
    process.exit(1)
  }
  const contracts = listNqContracts(args.scidDir)
  console.log(`Found ${contracts.length} NQ contracts in ${args.scidDir}`)
  if (contracts.length === 0) process.exit(1)

  const fromMs = args.from ? new Date(args.from + 'T00:00:00Z').getTime() : -Infinity
  const toMs = args.to ? new Date(args.to + 'T23:59:59.999Z').getTime() : Infinity
  const bucketMs = args.tfMin * 60_000

  const groups = {
    baseLong: newGroup(args.horizons.length),
    baseShort: newGroup(args.horizons.length),
    sigLong: newGroup(args.horizons.length),
    sigShort: newGroup(args.horizons.length),
  }
  let totalBars = 0

  for (const c of contracts) {
    const startMs = Math.max(c.activeStartMs, fromMs, c.fileFirstMs ?? -Infinity)
    const endMs = Math.min(c.activeEndMs, toMs, (c.fileLastMs ?? Infinity) + 1)
    if (startMs >= endMs) continue

    process.stdout.write(`  ${c.contract.padEnd(8)} ${fmtDate(startMs)} → ${fmtDate(endMs)}  `)
    // Probe price scaling (some files store unscaled prices → divisor 1).
    const probe = readScidDeltaBars(c.path, startMs, startMs + 60 * 60 * 1000, { priceDivisor: 100, bucketMs })
    const priceDivisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
    const { bars } = readScidDeltaBars(c.path, startMs, endMs, { priceDivisor, bucketMs })
    if (bars.length === 0) { console.log('(no bars)'); continue }
    if (priceDivisor !== 100) process.stdout.write(`[divisor=${priceDivisor}] `)

    processBars(bars, args, groups)
    totalBars += bars.length
    console.log(`bars=${pad(bars.length, 7)}`)
  }

  console.log(`\nTotal ${args.tfMin}m bars processed: ${totalBars}`)
  console.log(`Session filter: ${args.session.toUpperCase()}   ATR period: ${args.atrPeriod}   bracket: ${args.bracketK}xATR`)
  console.log('MFE/MAE are forward excursion in ATR units (entry = next bar open). "lift" = signal medMFE − baseline medMFE.')

  printSide('LONG (delta-dive reabsorbed)', groups.sigLong, groups.baseLong, args.horizons, args.tfMin)
  printSide('SHORT (delta-spike given back)', groups.sigShort, groups.baseShort, args.horizons, args.tfMin)
}

main().catch(e => { console.error(e); process.exit(1) })
