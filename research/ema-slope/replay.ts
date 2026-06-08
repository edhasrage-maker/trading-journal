import { readFileSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { emaSeries } from './ema'
import { loadOhlcBars, pickBestSymbol, type OhlcBar } from './load'
import { aggregate1mTo5m, isRTH, ptDateKey } from './aggregate'
import { atrWilder } from './atr'
import { listNqContracts } from './scid-discovery'
import { readScidBars } from '../../src/lib/scid-reader'

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

type Args = {
  source: 'scid' | 'db'
  from: string | null
  to: string | null
  symbol: string | null
  scidDir: string
  ema: number
  lookback: number
  atrPeriod: number
  targetR: number
  side: 'long' | 'short' | 'both'
  contracts: number
  mult: number
  rearmAtrFrac: number
}

function parseArgs(): Args {
  const a: Record<string, string> = {}
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i]
    const v = process.argv[i + 1]
    if (k.startsWith('--') && v !== undefined) a[k.slice(2)] = v
  }
  return {
    source: (a.source ?? 'scid') as 'scid' | 'db',
    from: a.from ?? null,
    to: a.to ?? null,
    symbol: a.symbol ?? null,
    scidDir: a['scid-dir'] ?? process.env.SIERRA_DATA_DIR ?? 'D:\\SierraCharts\\Data',
    ema: Number(a.ema ?? 9),
    lookback: Number(a.lookback ?? 3),
    atrPeriod: Number(a.atr ?? 10),
    targetR: Number(a.target ?? 2),
    side: (a.side ?? 'both') as Args['side'],
    contracts: Number(a.contracts ?? 5),
    mult: Number(a.mult ?? 2),
    rearmAtrFrac: Number(a.rearm ?? 0.5),
  }
}

type Side = 'long' | 'short'

type OpenPos = {
  side: Side
  entry: number
  stop: number
  target: number
  stopDist: number
  fillIdx1m: number
  scanStart1m: number
  signalTs: string
  slopeAtSignal: number
  emaDistAtSignal: number
}

export type Trade = {
  signalTs: string
  fillTs: string
  exitTs: string
  side: Side
  entry: number
  exit: number
  stop: number
  target: number
  stopDist: number
  R: number
  slope: number
  emaDistAtSignal: number
}

function fillLong(bar1m: OhlcBar, limit: number): number | null {
  if (bar1m.open <= limit) return bar1m.open
  if (bar1m.low <= limit) return limit
  return null
}
function fillShort(bar1m: OhlcBar, limit: number): number | null {
  if (bar1m.open >= limit) return bar1m.open
  if (bar1m.high >= limit) return limit
  return null
}

function checkExit(
  bars1m: OhlcBar[],
  pos: OpenPos,
  fromIdx: number,
  untilIdxExclusive: number,
): { idx: number; price: number; R: number } | null {
  for (let j = fromIdx; j < untilIdxExclusive && j < bars1m.length; j++) {
    if (!isRTH(bars1m[j].ts)) return null
    const b = bars1m[j]
    if (pos.side === 'long') {
      if (b.low <= pos.stop) return { idx: j, price: pos.stop, R: -1 }
      if (b.high >= pos.target) return { idx: j, price: pos.target, R: (pos.target - pos.entry) / pos.stopDist }
    } else {
      if (b.high >= pos.stop) return { idx: j, price: pos.stop, R: -1 }
      if (b.low <= pos.target) return { idx: j, price: pos.target, R: (pos.entry - pos.target) / pos.stopDist }
    }
  }
  return null
}

// Runs the pullback simulation on one continuous 1m bar series. Returns the
// trades that fired and the count of positions left open at end-of-day boundaries.
function simulate(bars1m: OhlcBar[], args: Args): { trades: Trade[]; unresolved: number } {
  if (bars1m.length < args.atrPeriod + 10) return { trades: [], unresolved: 0 }

  const isRTH1m = bars1m.map(b => isRTH(b.ts))
  const ptDate1m = bars1m.map(b => ptDateKey(b.ts))
  const atr1m = atrWilder(bars1m, args.atrPeriod)

  const { bars5m, ranges } = aggregate1mTo5m(bars1m)
  const rthMask5m = ranges.map(r => isRTH1m[r.start])

  const closes5m = bars5m.map(b => b.close)
  const ema5m = emaSeries(closes5m, args.ema)
  const slope5m: (number | null)[] = bars5m.map((_, i) =>
    i >= args.lookback ? (ema5m[i] - ema5m[i - args.lookback]) / args.lookback : null,
  )

  let bias: Side | null = null
  let armed = false
  let pendingLimit: { side: Side; price: number; slopeAtSignal: number; emaDistAtSignal: number } | null = null
  let posOpen: OpenPos | null = null
  let prevPtDate: string | null = null
  const trades: Trade[] = []
  let unresolved = 0

  const finalize = (exit: { idx: number; price: number; R: number }) => {
    if (!posOpen) return
    trades.push({
      signalTs: posOpen.signalTs,
      fillTs: bars1m[posOpen.fillIdx1m].ts,
      exitTs: bars1m[exit.idx].ts,
      side: posOpen.side,
      entry: posOpen.entry,
      exit: exit.price,
      stop: posOpen.stop,
      target: posOpen.target,
      stopDist: posOpen.stopDist,
      R: exit.R,
      slope: Math.abs(posOpen.slopeAtSignal),
      emaDistAtSignal: posOpen.emaDistAtSignal,
    })
    posOpen = null
    armed = false
  }

  for (let i = 0; i < bars5m.length; i++) {
    const range = ranges[i]
    const bar5m = bars5m[i]
    const slope = slope5m[i]
    const ema = ema5m[i]
    const inRTH = rthMask5m[i]
    const ptDate = ptDate1m[range.start]

    if (ptDate !== prevPtDate) {
      if (posOpen) unresolved++
      bias = null
      armed = false
      pendingLimit = null
      posOpen = null
      prevPtDate = ptDate
    }

    if (!inRTH) continue

    if (posOpen) {
      const exit = checkExit(bars1m, posOpen, posOpen.scanStart1m, range.end)
      if (exit) finalize(exit)
      else posOpen.scanStart1m = range.end
    }

    if (!posOpen && pendingLimit) {
      const lim = pendingLimit
      for (let j = range.start; j < range.end; j++) {
        const sub = bars1m[j]
        if (!isRTH1m[j]) break
        const fp = lim.side === 'long' ? fillLong(sub, lim.price) : fillShort(sub, lim.price)
        if (fp == null) continue
        const atrIdx = j - 1
        if (atrIdx < 0 || !Number.isFinite(atr1m[atrIdx])) break
        const stopDist = atr1m[atrIdx]
        const entry = fp
        const stop = lim.side === 'long' ? entry - stopDist : entry + stopDist
        const target = lim.side === 'long' ? entry + stopDist * args.targetR : entry - stopDist * args.targetR
        posOpen = {
          side: lim.side,
          entry,
          stop,
          target,
          stopDist,
          fillIdx1m: j,
          scanStart1m: j,
          signalTs: bars5m[i - 1]?.ts ?? bar5m.ts,
          slopeAtSignal: lim.slopeAtSignal,
          emaDistAtSignal: lim.emaDistAtSignal,
        }
        const exit = checkExit(bars1m, posOpen, j, range.end)
        if (exit) finalize(exit)
        else posOpen.scanStart1m = range.end
        break
      }
      pendingLimit = null
    }

    if (slope == null || !Number.isFinite(ema)) continue
    let newBias: Side | null = null
    if (bar5m.close > ema && slope > 0) newBias = 'long'
    else if (bar5m.close < ema && slope < 0) newBias = 'short'

    if (args.side === 'long' && newBias === 'short') newBias = null
    if (args.side === 'short' && newBias === 'long') newBias = null

    if (newBias !== bias) {
      armed = false
      bias = newBias
    }

    if (bias && !armed && !posOpen) {
      const lastIdx = range.end - 1
      const atrEnd = atr1m[lastIdx]
      if (Number.isFinite(atrEnd) && atrEnd > 0) {
        const sep = Math.abs(bar5m.close - ema)
        if (sep >= args.rearmAtrFrac * atrEnd) armed = true
      }
    }

    if (bias && armed && !posOpen) {
      pendingLimit = {
        side: bias,
        price: ema,
        slopeAtSignal: bias === 'long' ? slope : -slope,
        emaDistAtSignal: Math.abs(bar5m.close - ema),
      }
    } else {
      pendingLimit = null
    }
  }
  if (posOpen) unresolved++

  return { trades, unresolved }
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

async function loadAllTradesFromScid(args: Args): Promise<{ trades: Trade[]; unresolved: number; perContract: Array<{ contract: string; window: string; trades: number; bars: number }> }> {
  if (!existsSync(args.scidDir)) {
    console.error(`SCID dir not found: ${args.scidDir}`)
    console.error('Set SIERRA_DATA_DIR in .env.local or pass --scid-dir')
    process.exit(1)
  }
  const contracts = listNqContracts(args.scidDir)
  console.log(`Found ${contracts.length} NQ contracts in ${args.scidDir}`)
  if (contracts.length === 0) {
    console.error('No matching NQ[HMUZ]<year>.CME.scid files. Pass --scid-dir if your Sierra data lives elsewhere.')
    process.exit(1)
  }

  const fromMs = args.from ? new Date(args.from + 'T00:00:00Z').getTime() : -Infinity
  const toMs = args.to ? new Date(args.to + 'T23:59:59.999Z').getTime() : Infinity

  const allTrades: Trade[] = []
  let totalUnresolved = 0
  const perContract: Array<{ contract: string; window: string; trades: number; bars: number }> = []

  for (const c of contracts) {
    // Use the contract's front-month window, intersected with the user's --from/--to.
    const startMs = Math.max(c.activeStartMs, fromMs, c.fileFirstMs ?? -Infinity)
    const endMs = Math.min(c.activeEndMs, toMs, (c.fileLastMs ?? Infinity) + 1)
    if (startMs >= endMs) continue

    process.stdout.write(`  ${c.contract.padEnd(8)} ${fmtDate(startMs)} → ${fmtDate(endMs)}  `)
    const { bars } = readScidBars(c.path, startMs, endMs, { priceDivisor: 100, bucketMs: 60_000 })
    if (bars.length === 0) {
      console.log('(no bars)')
      continue
    }
    const { trades, unresolved } = simulate(bars as OhlcBar[], args)
    allTrades.push(...trades)
    totalUnresolved += unresolved
    perContract.push({
      contract: c.contract,
      window: `${fmtDate(startMs)} → ${fmtDate(endMs)}`,
      trades: trades.length,
      bars: bars.length,
    })
    console.log(`bars=${bars.length.toString().padStart(7)}  trades=${trades.length.toString().padStart(4)}  unresolved=${unresolved}`)
  }

  return { trades: allTrades, unresolved: totalUnresolved, perContract }
}

async function loadAllTradesFromDb(args: Args): Promise<{ trades: Trade[]; unresolved: number }> {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const symbol = args.symbol ?? await pickBestSymbol(sb)
  console.log(`symbol: ${symbol}`)
  const bars1m = await loadOhlcBars(sb, symbol, args.from ?? undefined, args.to ?? undefined)
  console.log(`loaded ${bars1m.length} 1m bars`)
  return simulate(bars1m, args)
}

function printReport(trades: Trade[], unresolved: number, args: Args) {
  console.log(`\ntrades: ${trades.length}  unresolved: ${unresolved}`)
  if (trades.length === 0) return

  const sorted = trades.map(t => t.slope).sort((a, b) => a - b)
  const p33 = sorted[Math.floor(sorted.length / 3)]
  const p66 = sorted[Math.floor((2 * sorted.length) / 3)]
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-9

  const bucketIdx = (s: number): 0 | 1 | 2 => (s <= p33 ? 0 : s <= p66 ? 1 : 2)
  const bucketTrades: Trade[][] = [[], [], []]
  for (const t of trades) bucketTrades[bucketIdx(t.slope)].push(t)

  const slopeToDeg = (pts: number) => (Math.atan(pts / median) * 180) / Math.PI
  const dollarPerPoint = args.mult * args.contracts
  const edges = [0, p33, p66, sorted[sorted.length - 1]]

  console.log('\nslope tercile edges (pts per 5m bar / %/bar / deg [median=45°]):')
  // Use median trade entry as a representative scale for %/bar
  const medianEntry = trades.map(t => t.entry).sort((a, b) => a - b)[Math.floor(trades.length / 2)] || 1
  for (let k = 0; k < 4; k++) {
    const pts = edges[k]
    const pct = (pts / medianEntry) * 100
    const deg = slopeToDeg(pts)
    console.log(`  edge${k}: ${pts.toFixed(3).padStart(8)} pts   ${pct.toFixed(5).padStart(10)} %    ${deg.toFixed(1).padStart(6)}°`)
  }

  console.log(`\n9 EMA pullback test — 5m signal, 1m exit walk, ${args.targetR}R target, ATR(${args.atrPeriod}) Wilder stop`)
  console.log(`side=${args.side}  contracts=${args.contracts}  $/pt=${args.mult}\n`)

  const cols = ['bucket', 'n', 'WR%', 'avgR', 'totalR', 'EV $', 'totalPnL $', 'avgWin $', 'avgLoss $', 'avgEMAdist']
  const widths = [12, 6, 7, 7, 9, 10, 14, 11, 11, 11]
  console.log(cols.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join(' '))
  const labels = ['shallow', 'typical', 'steep']
  const fmtRow = (label: string, ts: Trade[]) => {
    if (ts.length === 0) return [label.padEnd(widths[0]), '0'.padStart(widths[1])].join(' ')
    const n = ts.length
    const wins = ts.filter(t => t.R > 0)
    const losses = ts.filter(t => t.R <= 0)
    const wr = wins.length / n
    const avgR = ts.reduce((a, t) => a + t.R, 0) / n
    const totalR = ts.reduce((a, t) => a + t.R, 0)
    const totalPnL = ts.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0)
    const ev = totalPnL / n
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0) / wins.length : 0
    const avgLoss = losses.length ? losses.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0) / losses.length : 0
    const avgDist = ts.reduce((a, t) => a + t.emaDistAtSignal, 0) / n
    return [
      label.padEnd(widths[0]),
      String(n).padStart(widths[1]),
      ((wr * 100).toFixed(1) + '%').padStart(widths[2]),
      avgR.toFixed(2).padStart(widths[3]),
      totalR.toFixed(1).padStart(widths[4]),
      ev.toFixed(2).padStart(widths[5]),
      totalPnL.toFixed(2).padStart(widths[6]),
      avgWin.toFixed(2).padStart(widths[7]),
      avgLoss.toFixed(2).padStart(widths[8]),
      avgDist.toFixed(2).padStart(widths[9]),
    ].join(' ')
  }
  for (let k = 0; k < 3; k++) console.log(fmtRow(labels[k], bucketTrades[k]))
  console.log('-'.repeat(widths.reduce((a, b) => a + b + 1, 0)))
  console.log(fmtRow('OVERALL', trades))
  console.log(`\nunresolved (open at RTH close / session boundary): ${unresolved}`)
}

async function main() {
  const args = parseArgs()
  console.log('args:', args)

  let trades: Trade[]
  let unresolved: number

  if (args.source === 'scid') {
    const r = await loadAllTradesFromScid(args)
    trades = r.trades
    unresolved = r.unresolved
    console.log('\n== Per-contract summary ==')
    for (const pc of r.perContract) {
      console.log(`  ${pc.contract.padEnd(8)} ${pc.window}  bars=${pc.bars.toString().padStart(7)}  trades=${pc.trades.toString().padStart(4)}`)
    }
  } else {
    const r = await loadAllTradesFromDb(args)
    trades = r.trades
    unresolved = r.unresolved
  }

  printReport(trades, unresolved, args)
}

main().catch(e => { console.error(e); process.exit(1) })
