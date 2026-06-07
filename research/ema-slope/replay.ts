import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { emaSeries } from './ema'
import { loadOhlcBars, pickBestSymbol, type OhlcBar } from './load'
import { aggregate1mTo5m, isRTH, ptDateKey } from './aggregate'
import { atrWilder } from './atr'

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

type Args = {
  from: string | null
  to: string | null
  symbol: string | null
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
    from: a.from ?? null,
    to: a.to ?? null,
    symbol: a.symbol ?? null,
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
  slopeAtSignal: number // pts per 5m bar, direction-aligned (always >= 0)
  emaDistAtSignal: number // |close - ema| at signal bar
}

type Trade = {
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
  slope: number // direction-aligned, >= 0, pts/5m bar
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

// Walk 1m bars [fromIdx, untilIdxExclusive) checking for stop/target. Pessimistic on same-bar tie.
function checkExit(
  bars1m: OhlcBar[],
  pos: OpenPos,
  fromIdx: number,
  untilIdxExclusive: number,
): { idx: number; price: number; R: number } | null {
  for (let j = fromIdx; j < untilIdxExclusive && j < bars1m.length; j++) {
    if (!isRTH(bars1m[j].ts)) return null // shouldn't happen if walks are constrained, but guard
    const b = bars1m[j]
    if (pos.side === 'long') {
      const hitStop = b.low <= pos.stop
      const hitTgt = b.high >= pos.target
      if (hitStop) return { idx: j, price: pos.stop, R: -1 }
      if (hitTgt) return { idx: j, price: pos.target, R: (pos.target - pos.entry) / pos.stopDist }
    } else {
      const hitStop = b.high >= pos.stop
      const hitTgt = b.low <= pos.target
      if (hitStop) return { idx: j, price: pos.stop, R: -1 }
      if (hitTgt) return { idx: j, price: pos.target, R: (pos.entry - pos.target) / pos.stopDist }
    }
  }
  return null
}

async function main() {
  const args = parseArgs()
  console.log('args:', args)

  const symbol = args.symbol ?? await pickBestSymbol(sb)
  console.log(`symbol: ${symbol}`)

  console.log('loading 1m bars...')
  const bars1m = await loadOhlcBars(sb, symbol, args.from ?? undefined, args.to ?? undefined)
  console.log(`loaded ${bars1m.length} 1m bars`)
  if (bars1m.length < args.atrPeriod + 10) {
    console.error('not enough bars to run')
    process.exit(1)
  }

  const isRTH1m = bars1m.map(b => isRTH(b.ts))
  const ptDate1m = bars1m.map(b => ptDateKey(b.ts))
  const atr1m = atrWilder(bars1m, args.atrPeriod)

  const { bars5m, ranges } = aggregate1mTo5m(bars1m)
  // Restrict to 5m bars whose first 1m sub-bar is in RTH (RTH-anchored 5m bars only).
  const rthMask5m = ranges.map(r => isRTH1m[r.start])
  console.log(`aggregated to ${bars5m.length} 5m bars (${rthMask5m.filter(Boolean).length} in RTH)`)

  const closes5m = bars5m.map(b => b.close)
  const ema5m = emaSeries(closes5m, args.ema)
  // slope[i] = (ema5m[i] - ema5m[i - lookback]) / lookback   (pts per 5m bar)
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

    // STEP 1: position management — walk 1m bars within this 5m to detect stop/target.
    if (posOpen) {
      const exit = checkExit(bars1m, posOpen, posOpen.scanStart1m, range.end)
      if (exit) {
        const dirAlignedSlope = Math.abs(posOpen.slopeAtSignal)
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
          slope: dirAlignedSlope,
          emaDistAtSignal: posOpen.emaDistAtSignal,
        })
        posOpen = null
        armed = false
      } else {
        posOpen.scanStart1m = range.end
      }
    }

    // STEP 2: entry — only if no position and pendingLimit exists from prior bar.
    if (!posOpen && pendingLimit) {
      const lim = pendingLimit
      for (let j = range.start; j < range.end; j++) {
        const sub = bars1m[j]
        if (!isRTH1m[j]) break
        const fp = lim.side === 'long' ? fillLong(sub, lim.price) : fillShort(sub, lim.price)
        if (fp == null) continue
        const atrIdx = j - 1
        if (atrIdx < 0 || !Number.isFinite(atr1m[atrIdx])) break // ATR not warmed; skip this entry
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
        // Check for same-bar stop/target hit immediately (pessimistic).
        const exit = checkExit(bars1m, posOpen, j, range.end)
        if (exit) {
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
        } else {
          posOpen.scanStart1m = range.end
        }
        break
      }
      pendingLimit = null
    }

    // STEP 3: update bias from this bar's close.
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

    // STEP 4: arming via separation.
    if (bias && !armed && !posOpen) {
      const lastIdx = range.end - 1
      const atrEnd = atr1m[lastIdx]
      if (Number.isFinite(atrEnd) && atrEnd > 0) {
        const sep = Math.abs(bar5m.close - ema)
        if (sep >= args.rearmAtrFrac * atrEnd) armed = true
      }
    }

    // STEP 5: place pending limit for NEXT bar at the current bar's EMA.
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

  console.log(`\ntrades: ${trades.length}  unresolved: ${unresolved}`)
  if (trades.length === 0) return

  // Bucket by tercile of |slope at signal|.
  const sorted = trades.map(t => t.slope).sort((a, b) => a - b)
  const p33 = sorted[Math.floor(sorted.length / 3)]
  const p66 = sorted[Math.floor((2 * sorted.length) / 3)]
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-9

  const bucketIdx = (s: number): 0 | 1 | 2 => (s <= p33 ? 0 : s <= p66 ? 1 : 2)
  const bucketTrades: Trade[][] = [[], [], []]
  for (const t of trades) bucketTrades[bucketIdx(t.slope)].push(t)

  // Convert pts/bar slope → angle in degrees, anchored so median slope = 45°.
  const slopeToDeg = (pts: number) => (Math.atan(pts / median) * 180) / Math.PI

  const dollarPerPoint = args.mult * args.contracts
  const edges = [0, p33, p66, sorted[sorted.length - 1]]

  console.log('\nslope tercile edges (pts per 5m bar / %/bar / deg [median=45°]):')
  const medianClose = bars5m[bars5m.length - 1]?.close ?? 1
  for (let k = 0; k < 4; k++) {
    const pts = edges[k]
    const pct = (pts / medianClose) * 100
    const deg = slopeToDeg(pts)
    console.log(`  edge${k}: ${pts.toFixed(3).padStart(8)} pts   ${pct.toFixed(5).padStart(10)} %    ${deg.toFixed(1).padStart(6)}°`)
  }

  console.log(`\n9 EMA pullback test — 5m signal, 1m exit walk, ${args.targetR}R target, ATR(${args.atrPeriod}) Wilder stop`)
  console.log(`side=${args.side}  contracts=${args.contracts}  $/pt=${args.mult}\n`)

  const cols = ['bucket', 'n', 'WR%', 'avgR', 'totalR', 'EV $', 'totalPnL $', 'avgWin $', 'avgLoss $', 'avgEMAdist']
  const widths = [12, 5, 7, 7, 8, 9, 12, 10, 10, 11]
  console.log(cols.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join(' '))
  const labels = ['shallow', 'typical', 'steep']
  for (let k = 0; k < 3; k++) {
    const ts = bucketTrades[k]
    const n = ts.length
    if (n === 0) {
      console.log([labels[k].padEnd(widths[0]), '0'.padStart(widths[1])].join(' '))
      continue
    }
    const wins = ts.filter(t => t.R > 0)
    const losses = ts.filter(t => t.R <= 0)
    const wr = wins.length / n
    const avgR = ts.reduce((a, t) => a + t.R, 0) / n
    const totalR = ts.reduce((a, t) => a + t.R, 0)
    const avgWinDollar = wins.length
      ? wins.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0) / wins.length
      : 0
    const avgLossDollar = losses.length
      ? losses.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0) / losses.length
      : 0
    const totalPnL = ts.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0)
    const ev = totalPnL / n
    const avgDist = ts.reduce((a, t) => a + t.emaDistAtSignal, 0) / n
    console.log([
      labels[k].padEnd(widths[0]),
      String(n).padStart(widths[1]),
      ((wr * 100).toFixed(1) + '%').padStart(widths[2]),
      avgR.toFixed(2).padStart(widths[3]),
      totalR.toFixed(1).padStart(widths[4]),
      ev.toFixed(2).padStart(widths[5]),
      totalPnL.toFixed(2).padStart(widths[6]),
      avgWinDollar.toFixed(2).padStart(widths[7]),
      avgLossDollar.toFixed(2).padStart(widths[8]),
      avgDist.toFixed(2).padStart(widths[9]),
    ].join(' '))
  }

  // OVERALL row
  {
    const ts = trades
    const n = ts.length
    const wins = ts.filter(t => t.R > 0)
    const losses = ts.filter(t => t.R <= 0)
    const wr = wins.length / n
    const avgR = ts.reduce((a, t) => a + t.R, 0) / n
    const totalR = ts.reduce((a, t) => a + t.R, 0)
    const totalPnL = ts.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0)
    const ev = totalPnL / n
    const avgWinDollar = wins.length
      ? wins.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0) / wins.length
      : 0
    const avgLossDollar = losses.length
      ? losses.reduce((a, t) => a + t.R * t.stopDist * dollarPerPoint, 0) / losses.length
      : 0
    const avgDist = ts.reduce((a, t) => a + t.emaDistAtSignal, 0) / n
    console.log('-'.repeat(widths.reduce((a, b) => a + b + 1, 0)))
    console.log([
      'OVERALL'.padEnd(widths[0]),
      String(n).padStart(widths[1]),
      ((wr * 100).toFixed(1) + '%').padStart(widths[2]),
      avgR.toFixed(2).padStart(widths[3]),
      totalR.toFixed(1).padStart(widths[4]),
      ev.toFixed(2).padStart(widths[5]),
      totalPnL.toFixed(2).padStart(widths[6]),
      avgWinDollar.toFixed(2).padStart(widths[7]),
      avgLossDollar.toFixed(2).padStart(widths[8]),
      avgDist.toFixed(2).padStart(widths[9]),
    ].join(' '))
  }

  console.log(`\nunresolved (open at RTH close): ${unresolved}`)
}

main().catch(e => { console.error(e); process.exit(1) })
