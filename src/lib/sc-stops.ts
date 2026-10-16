/**
 * A trade's stop orders, read from the ORDER rows of a Sierra Chart trade
 * activity log: what the runner rule "breakeven only after TP1" grades
 * (src/lib/runner-rules.ts; plan docs/runner-t3-stop-log-plan.md).
 *
 * Sierra writes a row for every state an order passes through. A stop's price
 * history is the Price on the rows where it is working or about to be (Order
 * Sent, Pending Open, Pending Child-*, Open, Filled). The row that asks for a
 * change says who asked: "User order modification" is the trader (a drag on the
 * chart, an edit); what Sierra does by itself (re-placing the bracket at the
 * entry fill, following a moved entry order, an auto-trail) is "auto". A change
 * with no such row (made from another platform) counts as the trader's.
 *
 * Stops are found as the children of the trade's own entry orders
 * (ParentInternalOrderID), never by re-walking positions: Sierra's own log can
 * miss a fill (2026-08-04: a runner exit the trader added to the export by
 * hand), and a re-walk would then merge two trades.
 *
 * Pure and client-safe: the importers (server), the combine-all-accounts path
 * (browser) and the backfill (Sierra's binary daily files) all feed it rows.
 */
import type { TradeStopOrder, TradeStops } from '@/lib/supabase/types'

/** Bump when what is read, or how, changes. */
export const STOPS_VERSION = 'stops-1'

/** One order row of a Sierra activity log, as the stop reader needs it. */
export interface ScOrderRow {
  /** ms UTC */
  t: number
  account: string
  symbol: string
  /** InternalOrderID */
  ioid: string
  /** ParentInternalOrderID ('' when none) */
  parent: string
  /** OrderType ("Stop", "Limit", …) */
  type: string
  /** OrderStatus as Sierra's text export spells it */
  status: string
  /** Price; null when blank */
  price: number | null
  /** OrderActionSource */
  source: string
  /** Row order, for rows with the same time */
  seq: number
}

/** States in which a row's Price is the order's working price. */
const PRICED = new Set(['Order Sent', 'Pending Open', 'Pending Child-Client', 'Pending Child-Server', 'Open', 'Filled'])
const USER_RE = /User order modification/i
const AUTO_RE = /Modifying Attached Order|Auto trail|Increasing child order quantity|move to breakeven|trailing/i

export interface StopIndex {
  /** account|parent id → child order ids */
  byParent: Map<string, Set<string>>
  /** account|order id → its rows, oldest first */
  rowsByOrder: Map<string, ScOrderRow[]>
}

/** Index a log's order rows once; then read any number of trades from it. */
export function indexStopRows(rows: readonly ScOrderRow[]): StopIndex {
  const byParent = new Map<string, Set<string>>()
  const rowsByOrder = new Map<string, ScOrderRow[]>()
  for (const r of rows) {
    if (!r.ioid) continue
    const k = `${r.account}|${r.ioid}`
    const arr = rowsByOrder.get(k)
    if (arr) arr.push(r); else rowsByOrder.set(k, [r])
    if (r.parent) {
      const pk = `${r.account}|${r.parent}`
      const set = byParent.get(pk)
      if (set) set.add(r.ioid); else byParent.set(pk, new Set([r.ioid]))
    }
  }
  for (const arr of rowsByOrder.values()) arr.sort((a, b) => a.t - b.t || a.seq - b.seq)
  return { byParent, rowsByOrder }
}

/**
 * The stop orders attached to a trade's entry orders: each one's price when the
 * first entry filled (or when it was placed, if later), then every change.
 */
export function stopOrdersFor(ix: StopIndex, trade: { account: string; entryOrderIds: Iterable<string>; entryMs: number }): TradeStopOrder[] {
  const ids = new Set<string>()
  for (const e of trade.entryOrderIds) for (const c of ix.byParent.get(`${trade.account}|${e}`) ?? []) ids.add(c)
  const out: { first: number; order: TradeStopOrder }[] = []
  for (const id of ids) {
    const rows = ix.rowsByOrder.get(`${trade.account}|${id}`) ?? []
    if (!rows.some(r => /stop/i.test(r.type))) continue
    // every working price, in order, with who asked for each change
    const ev: { t: number; px: number; by: 'you' | 'auto' }[] = []
    let asked: 'you' | 'auto' | null = null
    for (const r of rows) {
      if (USER_RE.test(r.source)) asked = 'you'
      else if (AUTO_RE.test(r.source)) asked = 'auto'
      if (r.price == null || !Number.isFinite(r.price) || !PRICED.has(r.status)) continue
      const last = ev[ev.length - 1]
      // a working row at the same price: whatever was asked didn't move it
      if (last && last.px === r.price) { asked = null; continue }
      ev.push({ t: r.t, px: r.price, by: last ? (asked ?? 'you') : 'you' })
      asked = null
    }
    if (!ev.length) continue
    // before the entry filled only the price in force at the fill matters
    let i = 0
    while (i + 1 < ev.length && ev[i + 1].t <= trade.entryMs) i++
    const start = ev[i].t <= trade.entryMs ? { t: new Date(trade.entryMs).toISOString(), px: ev[i].px } : { t: new Date(ev[i].t).toISOString(), px: ev[i].px }
    const moves = ev.slice(i + 1).map(e => ({ t: new Date(e.t).toISOString(), px: e.px, by: e.by }))
    out.push({ first: ev[i].t, order: { start, moves } })
  }
  return out.sort((a, b) => a.first - b.first).map(x => x.order)
}

/** The fill a stop history was read for. */
export function stopsFingerprint(t: { entry_time?: string | null; entry_price?: number | string | null; direction?: string | null; symbol?: string | null }): string {
  return `${Date.parse(t.entry_time ?? '')}|${Number(t.entry_price)}|${t.direction ?? ''}|${t.symbol ?? ''}`
}

export function makeTradeStops(orders: TradeStopOrder[], t: Parameters<typeof stopsFingerprint>[0], at = new Date().toISOString()): TradeStops {
  return { v: STOPS_VERSION, src: stopsFingerprint(t), orders, at }
}

const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))
const isPx = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Stop orders from an untrusted source (the browser's combine path, a stored
 * row): only the shape this file writes survives; null when nothing does.
 */
export function readStopOrders(raw: unknown): TradeStopOrder[] | null {
  if (!Array.isArray(raw)) return null
  const out: TradeStopOrder[] = []
  for (const o of raw.slice(0, 50)) {
    const s = (o as { start?: { t?: unknown; px?: unknown } } | null)?.start
    if (!s || !isIso(s.t) || !isPx(s.px)) continue
    const moves: TradeStopOrder['moves'] = []
    const mv = (o as { moves?: unknown }).moves
    for (const m of Array.isArray(mv) ? mv.slice(0, 500) : []) {
      const x = m as { t?: unknown; px?: unknown; by?: unknown }
      if (isIso(x.t) && isPx(x.px)) moves.push({ t: x.t, px: x.px, by: x.by === 'auto' ? 'auto' : 'you' })
    }
    out.push({ start: { t: s.t, px: s.px }, moves })
  }
  return out
}

/**
 * Two stop histories hold the same thing. Compared field by field: the database
 * stores jsonb with its own key order, so the stored JSON never matches a fresh
 * JSON.stringify of the same orders.
 */
export function sameStopHistory(a: TradeStops | null | undefined, b: TradeStops): boolean {
  if (!a || a.v !== b.v || a.src !== b.src) return false
  const flat = (os: TradeStopOrder[] | undefined) => JSON.stringify((os ?? []).map(o => [o.start?.t, o.start?.px, (o.moves ?? []).map(m => [m.t, m.px, m.by])]))
  return flat(a.orders) === flat(b.orders)
}

/** A trade's stored stop history, or null when there is none to grade from. */
export function storedStops(raw: unknown): TradeStops | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<TradeStops>
  if (s.v !== STOPS_VERSION) return null
  const orders = readStopOrders(s.orders)
  return orders ? { v: s.v, src: typeof s.src === 'string' ? s.src : '', orders, at: typeof s.at === 'string' ? s.at : '' } : null
}
