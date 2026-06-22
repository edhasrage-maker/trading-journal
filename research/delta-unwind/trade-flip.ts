import { readFileSync, existsSync } from 'fs'
import Papa from 'papaparse'
import { listNqContracts, type ContractFile } from '../ema-slope/scid-discovery'
import { readScidDeltaBars } from './scid-delta'
import { computeSignals, DEFAULT_PARAMS, type SignalParams, type SignalSide } from './signal'

// Does a Delta Unwind "flip" in the 5 minutes BEFORE entry coincide with better
// trade outcomes? Loads the user's Tradezella trades, and for each one checks the
// NQ tick-reconstructed delta signal in the 5 completed 1m bars before entry, then
// compares stats for trades WITH a preceding flip vs WITHOUT.
//
// Flip = the study's signal (default params) on NQ front-month footprint.
// "5 min before" = the 5 fully-closed 1m bars ending the minute before entry
// (a bar is only known once closed → EvaluateOnClose, no lookahead).

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
const CSV = a.csv ?? 'C:\\Users\\lamed\\Downloads\\TZ_trades_20260504103020_2025-YTD2026.csv'
const SCID_DIR = a['scid-dir'] ?? process.env.SIERRA_DATA_DIR ?? 'D:\\SierraCharts\\Data'
const WINDOW_MIN = Number(a.window ?? 5)
const PARAMS: SignalParams = {
  ...DEFAULT_PARAMS,
  unwindStrThresh: Number(a.str ?? DEFAULT_PARAMS.unwindStrThresh),
  minDeltaFloor: Number(a.floor ?? DEFAULT_PARAMS.minDeltaFloor),
  maxDeltaFloor: Number(a.floor ?? DEFAULT_PARAMS.maxDeltaFloor),
  impulseMult: Number(a.imp ?? DEFAULT_PARAMS.impulseMult),
}

type Trade = {
  entryMs: number
  side: 'long' | 'short'
  pnl: number
  points: number
  rr: number | null
  setups: string[]
}

// "2026-02-05" + "08:41:11 PST" → UTC ms. PST=UTC-8, PDT=UTC-7.
function parseEntry(date: string, time: string): number | null {
  const dm = date.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  const tm = time.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(PST|PDT)$/i)
  if (!dm || !tm) return null
  const [, y, mo, d] = dm.map(Number) as unknown as number[]
  const hh = Number(tm[1]), mm = Number(tm[2]), ss = Number(tm[3])
  const offH = tm[4].toUpperCase() === 'PST' ? 8 : 7
  return Date.UTC(y, mo - 1, d, hh, mm, ss) + offH * 3600_000
}

function loadTrades(): Trade[] {
  const txt = readFileSync(CSV, 'utf8')
  const { data } = Papa.parse<Record<string, string>>(txt, { header: true, skipEmptyLines: true })
  const out: Trade[] = []
  for (const r of data) {
    const entryMs = parseEntry(r['Open Date'] ?? '', r['Open Time'] ?? '')
    const sideRaw = (r['Side'] ?? '').trim().toLowerCase()
    if (entryMs == null || (sideRaw !== 'long' && sideRaw !== 'short')) continue
    const pnl = parseFloat(r['Net P&L'] ?? '')
    if (!Number.isFinite(pnl)) continue
    const rrRaw = (r['Realized RR'] ?? '').trim()
    const setups = (r['Setups'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    out.push({
      entryMs,
      side: sideRaw,
      pnl,
      points: parseFloat(r['Points'] ?? '') || 0,
      rr: rrRaw ? parseFloat(rrRaw) : null,
      setups: setups.length ? setups : ['(no setup)'],
    })
  }
  return out
}

const PT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
})
const ptDay = (ms: number) => PT_DATE.format(new Date(ms))

type Stat = { n: number; wins: number; sumPnl: number; sumPts: number; rrSum: number; rrN: number }
const newStat = (): Stat => ({ n: 0, wins: 0, sumPnl: 0, sumPts: 0, rrSum: 0, rrN: 0 })
function add(s: Stat, t: Trade) {
  s.n++; if (t.pnl > 0) s.wins++
  s.sumPnl += t.pnl; s.sumPts += t.points
  if (t.rr != null && Number.isFinite(t.rr)) { s.rrSum += t.rr; s.rrN++ }
}
function fmt(s: Stat): string {
  if (s.n === 0) return 'n=0'
  const wr = (100 * s.wins / s.n).toFixed(1)
  const avgP = (s.sumPnl / s.n).toFixed(2)
  const avgPts = (s.sumPts / s.n).toFixed(2)
  const rr = s.rrN ? (s.rrSum / s.rrN).toFixed(2) : '—'
  return `n=${String(s.n).padStart(4)}  win%=${wr.padStart(5)}  avg$=${avgP.padStart(9)}  total$=${s.sumPnl.toFixed(0).padStart(8)}  avgPts=${avgPts.padStart(7)}  avgRR=${rr.padStart(6)}`
}

function main() {
  const trades = loadTrades()
  console.log(`Loaded ${trades.length} trades with parseable entry + side + P&L`)
  if (!existsSync(SCID_DIR)) { console.error(`SCID dir not found: ${SCID_DIR}`); process.exit(1) }
  const contracts = listNqContracts(SCID_DIR)

  // Map each trade to the NQ front-month contract active at entry.
  const pickContract = (ms: number): ContractFile | null =>
    contracts.find(c => ms >= c.activeStartMs && ms < c.activeEndMs
      && ms >= (c.fileFirstMs ?? -Infinity) && ms <= (c.fileLastMs ?? Infinity)) ?? null

  // Group by (contract, PT date) so each session-window is read once.
  const groups = new Map<string, { c: ContractFile; trades: Trade[] }>()
  let unmapped = 0
  for (const t of trades) {
    const c = pickContract(t.entryMs)
    if (!c) { unmapped++; continue }
    const key = `${c.path}|${ptDay(t.entryMs)}`
    if (!groups.has(key)) groups.set(key, { c, trades: [] })
    groups.get(key)!.trades.push(t)
  }
  console.log(`Mapped to ${groups.size} (contract, day) groups; ${unmapped} trades unmapped (outside .scid coverage)`)

  // Outcome buckets — prior-5m window.
  const noFlip = newStat(), anyFlip = newStat()
  const alignedFlip = newStat(), notAligned = newStat()
  const opposingFlip = newStat()
  // ±5m window (prior 5, entry minute, after 5). "after" bars close after entry,
  // so they're NOT actionable for entry timing — shown only because asked.
  const noFlipA = newStat(), anyFlipA = newStat()
  const alignedA = newStat(), notAlignedA = newStat()
  const opposingA = newStat()
  // Side split (prior-5m window): per side → no/any/aligned/opposing.
  type SideBkt = { no: Stat; any: Stat; al: Stat; op: Stat }
  const mkSide = (): SideBkt => ({ no: newStat(), any: newStat(), al: newStat(), op: newStat() })
  const bySide: Record<'long' | 'short', SideBkt> = { long: mkSide(), short: mkSide() }
  // Per-setup (prior-5m window): tag → all/no/any/opposing.
  type SetupBkt = { all: Stat; no: Stat; any: Stat; op: Stat }
  const bySetup = new Map<string, SetupBkt>()
  const getSetup = (k: string): SetupBkt => {
    let b = bySetup.get(k)
    if (!b) { b = { all: newStat(), no: newStat(), any: newStat(), op: newStat() }; bySetup.set(k, b) }
    return b
  }
  let evaluated = 0

  let gi = 0
  for (const { c, trades: grp } of groups.values()) {
    gi++
    const minMs = Math.min(...grp.map(t => t.entryMs))
    const maxMs = Math.max(...grp.map(t => t.entryMs))
    const startMs = minMs - 3 * 3600_000 // 3h warmup for EMA(30)/ATR
    const endMs = maxMs + (WINDOW_MIN + 1) * 60_000 // +bars after latest entry for the ±window
    const probe = readScidDeltaBars(c.path, startMs, startMs + 3600_000, { priceDivisor: 100 })
    const priceDivisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
    const { bars } = readScidDeltaBars(c.path, startMs, endMs, { priceDivisor })
    if (bars.length === 0) continue
    const signals = computeSignals(bars, PARAMS)
    // minute-ms → signal side
    const sideAt = new Map<number, SignalSide>()
    for (let i = 0; i < bars.length; i++) sideAt.set(Date.parse(bars[i].ts), signals[i].side)

    for (const t of grp) {
      const entryMin = Math.floor(t.entryMs / 60_000) * 60_000
      // prior-5m = offsets [-5..-1]; ±5m = offsets [-5..+5] (incl. entry minute & after)
      let pAny = false, pAl = false, pOp = false // prior window
      let aAny = false, aAl = false, aOp = false // ±window
      for (let off = -WINDOW_MIN; off <= WINDOW_MIN; off++) {
        const s = sideAt.get(entryMin + off * 60_000)
        if (s !== 'long' && s !== 'short') continue
        const al = s === t.side
        aAny = true; if (al) aAl = true; else aOp = true
        if (off < 0) { pAny = true; if (al) pAl = true; else pOp = true }
      }
      evaluated++
      if (pAny) add(anyFlip, t); else add(noFlip, t)
      if (pAl) add(alignedFlip, t); else add(notAligned, t)
      if (pOp) add(opposingFlip, t)
      if (aAny) add(anyFlipA, t); else add(noFlipA, t)
      if (aAl) add(alignedA, t); else add(notAlignedA, t)
      if (aOp) add(opposingA, t)

      // Side split (prior-5m window).
      const sb = bySide[t.side]
      if (pAny) add(sb.any, t); else add(sb.no, t)
      if (pAl) add(sb.al, t)
      if (pOp) add(sb.op, t)

      // Per-setup (prior-5m window) — trade counts under each of its setup tags.
      for (const tag of t.setups) {
        const su = getSetup(tag)
        add(su.all, t)
        if (pAny) add(su.any, t); else add(su.no, t)
        if (pOp) add(su.op, t)
      }
    }
    if (gi % 50 === 0) process.stdout.write(`  ...${gi}/${groups.size} groups\r`)
  }

  console.log(`\nEvaluated ${evaluated} trades against NQ delta.`)
  console.log(`Flip = study signal (str ${PARAMS.unwindStrThresh}, floor ${PARAMS.minDeltaFloor}, imp ${PARAMS.impulseMult}).`)
  const all = newStat(); for (const t of trades) { const c = pickContract(t.entryMs); if (c) add(all, t) }
  console.log(`  ALL mapped ${fmt(all)}`)

  console.log(`\n══════════ WINDOW A: ${WINDOW_MIN}m BEFORE entry ══════════`)
  console.log(`  NO flip    ${fmt(noFlip)}`)
  console.log(`  ANY flip   ${fmt(anyFlip)}`)
  console.log(`  aligned    ${fmt(alignedFlip)}`)
  console.log(`  OPPOSING   ${fmt(opposingFlip)}`)

  console.log(`\n══════════ WINDOW B: ±${WINDOW_MIN}m around entry (incl. after) ══════════`)
  console.log(`  NO flip    ${fmt(noFlipA)}`)
  console.log(`  ANY flip   ${fmt(anyFlipA)}`)
  console.log(`  aligned    ${fmt(alignedA)}`)
  console.log(`  OPPOSING   ${fmt(opposingA)}`)

  console.log(`\n══════════ LONG vs SHORT split (${WINDOW_MIN}m before) ══════════`)
  for (const side of ['long', 'short'] as const) {
    const b = bySide[side]
    console.log(`  ${side.toUpperCase()}`)
    console.log(`    NO flip    ${fmt(b.no)}`)
    console.log(`    ANY flip   ${fmt(b.any)}`)
    console.log(`    aligned    ${fmt(b.al)}`)
    console.log(`    OPPOSING   ${fmt(b.op)}`)
  }

  console.log(`\n══════════ BY SETUP — flip vs no-flip (${WINDOW_MIN}m before) ══════════`)
  const setupsSorted = [...bySetup.entries()].sort((a, b) => b[1].all.n - a[1].all.n)
  for (const [tag, b] of setupsSorted) {
    if (b.all.n < 10) continue
    console.log(`  ${tag}  (${b.all.n} trades)`)
    console.log(`    ALL        ${fmt(b.all)}`)
    console.log(`    NO flip    ${fmt(b.no)}`)
    console.log(`    ANY flip   ${fmt(b.any)}`)
    console.log(`    OPPOSING   ${fmt(b.op)}`)
  }
}

main()
