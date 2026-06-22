import { readFileSync, existsSync } from 'fs'
import { listNqContracts } from '../ema-slope/scid-discovery'
import { atrWilder } from '../ema-slope/atr'
import { readScidDeltaBars, type DeltaBar } from './scid-delta'
import { buildEnvelope, signalSideAt, DEFAULT_PARAMS, type SignalParams } from './signal'

// Parameter sweep + time-of-day segmentation for Delta Unwind Stars, in ONE pass
// over the .scid files. The forward bracket-race outcome of each bar is
// param-independent (params only decide WHICH bars fire), so we precompute each
// bar's outcome once and reuse it across the whole grid and every time bucket.
//
// Headline metric: 1:1 ATR bracket-race win rate (favorable ±k×ATR touched
// before adverse, within the horizon) vs the same-side baseline over all bars.

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
  horizon: number // race horizon in bars
  bracketK: number
  emaLength: number
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
    emaLength: Number(a.ema ?? DEFAULT_PARAMS.emaLength),
  }
}

// --- Parameter grid ---------------------------------------------------------
const STR_GRID = [1.0, 1.25, 1.5, 2.0] // unwind strength threshold
const FLOOR_GRID = [100, 150, 200, 300] // min/max delta floor (tied)
const IMP_GRID = [0.8, 1.0, 1.5] // impulse multiple vs EMA

type Combo = { str: number; floor: number; imp: number; params: SignalParams }
function buildGrid(emaLength: number): Combo[] {
  const out: Combo[] = []
  for (const str of STR_GRID)
    for (const floor of FLOOR_GRID)
      for (const imp of IMP_GRID)
        out.push({
          str, floor, imp,
          params: {
            ...DEFAULT_PARAMS,
            emaLength,
            unwindStrThresh: str,
            minDeltaFloor: floor,
            maxDeltaFloor: floor,
            impulseMult: imp,
          },
        })
  return out
}

type Race = { win: number; loss: number; n: number }
const newRace = (): Race => ({ win: 0, loss: 0, n: 0 })
function wr(r: Race): number {
  const dec = r.win + r.loss
  return dec > 0 ? (100 * r.win) / dec : NaN
}
// 1=win, 2=loss, 0=neither
function addOutcome(r: Race, o: number) {
  r.n++
  if (o === 1) r.win++
  else if (o === 2) r.loss++
}

// PT 30-minute RTH bucket index (06:30→0 … 12:30→12), or -1 outside RTH.
const PT_HM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit',
})
function todBucket(tsIso: string): number {
  const parts = PT_HM.formatToParts(new Date(tsIso))
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10)
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10)
  const mins = h * 60 + m
  if (mins < 390 || mins >= 780) return -1
  return Math.floor((mins - 390) / 30)
}
const TOD_LABELS = Array.from({ length: 13 }, (_, i) => {
  const start = 390 + i * 30
  const hh = String(Math.floor(start / 60)).padStart(2, '0')
  const mm = String(start % 60).padStart(2, '0')
  return `${hh}:${mm}`
})

// long: fav = up, adv = down. short: fav = down, adv = up. Same-bar → adverse.
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

  if (!existsSync(args.scidDir)) {
    console.error(`SCID dir not found: ${args.scidDir}`); process.exit(1)
  }
  const contracts = listNqContracts(args.scidDir)
  console.log(`Found ${contracts.length} NQ contracts`)
  if (contracts.length === 0) process.exit(1)

  const fromMs = args.from ? new Date(args.from + 'T00:00:00Z').getTime() : -Infinity
  const toMs = args.to ? new Date(args.to + 'T23:59:59.999Z').getTime() : Infinity
  const bucketMs = args.tfMin * 60_000
  const H = args.horizon

  const grid = buildGrid(args.emaLength)
  const baseLong = newRace(), baseShort = newRace()
  const comboLong = grid.map(newRace), comboShort = grid.map(newRace)
  // Time-of-day at default params.
  const todBaseLong = TOD_LABELS.map(newRace), todBaseShort = TOD_LABELS.map(newRace)
  const todSigLong = TOD_LABELS.map(newRace), todSigShort = TOD_LABELS.map(newRace)
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
    const env = buildEnvelope(bars, args.emaLength)

    // Precompute param-independent per-bar outcomes for eligible bars.
    const eligible = new Uint8Array(n)
    const longOut = new Int8Array(n)
    const shortOut = new Int8Array(n)
    const tod = new Int8Array(n)

    for (let i = 0; i < n - H - 1; i++) {
      const a = atr[i]
      if (!Number.isFinite(a) || a <= 0) continue
      const tb = todBucket(bars[i].ts) // RTH only
      if (tb < 0) continue
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
      tod[i] = tb
      longOut[i] = raceOutcome(firstUp, firstDown, 'long')
      shortOut[i] = raceOutcome(firstUp, firstDown, 'short')

      // Baseline (param-independent) + TOD baseline.
      addOutcome(baseLong, longOut[i])
      addOutcome(baseShort, shortOut[i])
      addOutcome(todBaseLong[tb], longOut[i])
      addOutcome(todBaseShort[tb], shortOut[i])
    }

    // Parameter grid: tally precomputed outcomes for the bars each combo fires.
    for (let g = 0; g < grid.length; g++) {
      const p = grid[g].params
      const cl = comboLong[g], cs = comboShort[g]
      for (let i = 0; i < n - H - 1; i++) {
        if (!eligible[i]) continue
        const side = signalSideAt(i, bars, env, p)
        if (side === 'long') addOutcome(cl, longOut[i])
        else if (side === 'short') addOutcome(cs, shortOut[i])
      }
    }

    // Time-of-day at default params.
    for (let i = 0; i < n - H - 1; i++) {
      if (!eligible[i]) continue
      const side = signalSideAt(i, bars, env, { ...DEFAULT_PARAMS, emaLength: args.emaLength })
      if (side === 'long') addOutcome(todSigLong[tod[i]], longOut[i])
      else if (side === 'short') addOutcome(todSigShort[tod[i]], shortOut[i])
    }

    totalBars += n
    console.log(`bars=${String(n).padStart(7)}`)
  }

  const bL = wr(baseLong), bS = wr(baseShort)
  console.log(`\nTotal ${args.tfMin}m bars: ${totalBars}   horizon ${H} bars   bracket ${args.bracketK}xATR`)
  console.log(`Baseline race WR — long ${bL.toFixed(1)}%  short ${bS.toFixed(1)}%  (n=${baseLong.n})`)

  // --- Parameter sweep, ranked by edge vs baseline ---
  const rows = grid.map((c, g) => ({
    c,
    longWr: wr(comboLong[g]), longN: comboLong[g].n, longEdge: wr(comboLong[g]) - bL,
    shortWr: wr(comboShort[g]), shortN: comboShort[g].n, shortEdge: wr(comboShort[g]) - bS,
  }))
  const MIN_N = 200 // ignore param combos too sparse to mean anything

  const printRanked = (title: string, side: 'long' | 'short') => {
    console.log(`\n=== ${title} — top combos by edge (min n=${MIN_N}) ===`)
    console.log('  ' + 'str'.padEnd(6) + 'floor'.padEnd(7) + 'imp'.padEnd(6) + 'WR'.padStart(8) + 'edge'.padStart(9) + 'n'.padStart(9))
    const ranked = [...rows]
      .filter(r => (side === 'long' ? r.longN : r.shortN) >= MIN_N)
      .sort((a, b) => (side === 'long' ? b.longEdge - a.longEdge : b.shortEdge - a.shortEdge))
    for (const r of ranked.slice(0, 8)) {
      const w = side === 'long' ? r.longWr : r.shortWr
      const e = side === 'long' ? r.longEdge : r.shortEdge
      const nn = side === 'long' ? r.longN : r.shortN
      console.log('  ' +
        String(r.c.str).padEnd(6) + String(r.c.floor).padEnd(7) + String(r.c.imp).padEnd(6) +
        (w.toFixed(1) + '%').padStart(8) + ((e >= 0 ? '+' : '') + e.toFixed(1) + 'pp').padStart(9) +
        String(nn).padStart(9))
    }
  }
  printRanked('LONG sweep', 'long')
  printRanked('SHORT sweep', 'short')

  // --- Time-of-day (default params) ---
  const printTod = (title: string, sig: Race[], base: Race[]) => {
    console.log(`\n=== ${title} — time of day (default params) ===`)
    console.log('  ' + 'PT'.padEnd(8) + 'sigWR'.padStart(8) + 'baseWR'.padStart(8) + 'edge'.padStart(9) + 'n'.padStart(8))
    for (let i = 0; i < TOD_LABELS.length; i++) {
      const sw = wr(sig[i]), bw = wr(base[i]), e = sw - bw
      console.log('  ' + TOD_LABELS[i].padEnd(8) +
        (Number.isFinite(sw) ? sw.toFixed(1) + '%' : '—').padStart(8) +
        (Number.isFinite(bw) ? bw.toFixed(1) + '%' : '—').padStart(8) +
        (Number.isFinite(e) ? (e >= 0 ? '+' : '') + e.toFixed(1) + 'pp' : '—').padStart(9) +
        String(sig[i].n).padStart(8))
    }
  }
  printTod('LONG', todSigLong, todBaseLong)
  printTod('SHORT', todSigShort, todBaseShort)
}

main()
