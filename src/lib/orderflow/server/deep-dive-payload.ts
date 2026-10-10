/**
 * The Deep Dive workspace payload for one trade.
 *
 * BLIND (default): the header carries ONLY entry-time facts — date, weekday,
 * time, instrument, direction, entry price — and the market data ends before
 * the fill second (buildSnapshot). No exit, P&L, notes, screenshot, tags or
 * score is read into it, so none can be sent.
 *
 * Full (blind=false): the deep chart review. Market data runs on past the
 * last exit, and the exit fills are included for the chart markers.
 *
 * Two data sources, one builder:
 *   buildDeepDivePayload          — local build, Sierra .scid on this machine
 *   buildDeepDivePayloadFromTape  — hosted build, the published tick tape
 */
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { buildSnapshot, snapshotWindow, type DeepDiveSnapshot, type SnapshotRequest } from './snapshot'
import type { TickSource } from './tick-source'
import { loadTapeSource, TapeUnavailable, type TapeStore } from './tape-store'
import type { OfRoot } from '../ticks'
import { utcToPtMs } from '../pt-clock'

/** Only entry-time columns: everything a blind payload may be built from. */
export const BLIND_TRADE_COLUMNS = 'id, symbol, entry_time, entry_price, direction, stop_price, tp1_price, entry_atr_1m'
/** Extra columns for the non-blind review (exit markers). */
export const FULL_TRADE_COLUMNS = `${BLIND_TRADE_COLUMNS}, exit_time, exit_price, exits_json`

export interface DeepDiveTradeRow {
  id: string
  symbol: string | null
  entry_time: string | null
  entry_price: number | string | null
  direction: 'long' | 'short' | null
  stop_price: number | string | null
  tp1_price: number | string | null
  entry_atr_1m: number | string | null
  exit_time?: string | null
  exit_price?: number | string | null
  exits_json?: { time: string; price: number; qty: number }[] | null
}

export interface DeepDiveExit { time: number; price: number; qty: number | null }

export interface DeepDivePayload {
  trade: { id: string; symbol: string; inst: OfRoot }
  blind: boolean
  snapshot: DeepDiveSnapshot
  /** Exit fills, PT-clock seconds. Non-blind only; never present when blind. */
  exits?: DeepDiveExit[]
  build_ms: number
}

export interface DeepDiveOptions { blind: boolean; atrStopTarget: number; tp1RMultiple: number; nowMs?: number }

export class DeepDiveError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const num = (x: number | string | null | undefined) => (x == null || x === '' ? null : Number(x))

/** Minutes of tape shown after the last exit in the non-blind review. */
const AFTER_EXIT_MS = 30 * 60_000

/** Validate the trade and turn it into a snapshot request (+ exits when not blind). */
function prepare(row: DeepDiveTradeRow, opts: DeepDiveOptions): { req: SnapshotRequest; exits?: DeepDiveExit[] } {
  const root = row.symbol ? chartSeriesRoot(row.symbol) : ''
  if (root !== 'NQ' && root !== 'ES') throw new DeepDiveError(`Deep Dive supports NQ/MNQ and ES/MES; this trade is ${row.symbol ?? 'unknown'}`, 422)
  const entryUtcMs = row.entry_time ? Date.parse(row.entry_time) : NaN
  const entryPrice = num(row.entry_price)
  if (!Number.isFinite(entryUtcMs) || entryPrice == null || (row.direction !== 'long' && row.direction !== 'short')) {
    throw new DeepDiveError('trade is missing its entry time, price or direction', 422)
  }
  let displayEndUtcMs: number | undefined
  let exits: DeepDiveExit[] | undefined
  if (!opts.blind) {
    const legs = Array.isArray(row.exits_json) && row.exits_json.length
      ? row.exits_json.map(e => ({ ms: Date.parse(e.time), price: Number(e.price), qty: Number(e.qty) }))
      : row.exit_time ? [{ ms: Date.parse(row.exit_time), price: num(row.exit_price) ?? NaN, qty: NaN }] : []
    const valid = legs.filter(l => Number.isFinite(l.ms) && Number.isFinite(l.price))
    const lastExit = valid.length ? Math.max(...valid.map(l => l.ms)) : entryUtcMs + 30 * 60_000
    displayEndUtcMs = Math.min(lastExit + AFTER_EXIT_MS, opts.nowMs ?? Date.now())
    // exit instants onto the PT clock the chart runs on
    exits = valid.map(l => ({ time: Math.floor(utcToPtMs(l.ms) / 1000), price: l.price, qty: Number.isFinite(l.qty) ? l.qty : null }))
  }
  return {
    req: {
      root, entryUtcMs, direction: row.direction, entryPrice,
      atrStopTarget: opts.atrStopTarget, tp1RMultiple: opts.tp1RMultiple,
      recordedStop: num(row.stop_price), recordedTp: num(row.tp1_price), entryAtr: num(row.entry_atr_1m),
      displayEndUtcMs,
    },
    exits,
  }
}

function finish(row: DeepDiveTradeRow, opts: DeepDiveOptions, p: ReturnType<typeof prepare>, source: TickSource | undefined, t0: number): DeepDivePayload {
  const snapshot = buildSnapshot(p.req, source)
  return {
    trade: { id: row.id, symbol: row.symbol ?? p.req.root, inst: p.req.root },
    blind: opts.blind,
    snapshot,
    ...(p.exits ? { exits: p.exits } : {}),
    build_ms: Math.round(performance.now() - t0),
  }
}

/** Local build: Sierra .scid files on this machine. */
export function buildDeepDivePayload(row: DeepDiveTradeRow, opts: DeepDiveOptions, source?: TickSource): DeepDivePayload {
  const t0 = performance.now()
  return finish(row, opts, prepare(row, opts), source, t0)
}

/** Hosted build: fetch the hours this trade needs from the published tape, then the same builder. */
export async function buildDeepDivePayloadFromTape(row: DeepDiveTradeRow, opts: DeepDiveOptions, store: TapeStore): Promise<DeepDivePayload> {
  const t0 = performance.now()
  const p = prepare(row, opts)
  try {
    const source = await loadTapeSource(store, p.req.root, p.req.displayEndUtcMs ?? p.req.entryUtcMs,
      idx => snapshotWindow(idx, p.req.entryUtcMs)?.startPt ?? null)
    return finish(row, opts, p, source, t0)
  } catch (e) {
    if (e instanceof TapeUnavailable) throw new DeepDiveError(e.message, 404)
    throw e
  }
}
