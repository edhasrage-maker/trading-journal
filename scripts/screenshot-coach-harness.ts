/**
 * Screenshot-coach OFFLINE harness — step 1 of the build.
 *
 *   npx tsx scripts/screenshot-coach-harness.ts                  # prod (public-feed), owner only
 *   npx tsx scripts/screenshot-coach-harness.ts --env=local
 *   npx tsx scripts/screenshot-coach-harness.ts --limit=20
 *   npx tsx scripts/screenshot-coach-harness.ts --out=<dir>
 *
 * Pulls every trade the trader has put a Game-film verdict on
 * (`trades.review_json.verdict`, written by /api/trades/[id]/review) and packs
 * each one into a single self-contained record: the screenshot, the trader's
 * CLAIM (setup tags + notes), and the tape TRUTH computed from 1-minute bars.
 *
 * WRITES NOTHING. Reads prod, emits JSONL + a summary to disk. Every later step
 * — prompt, scoring, the site route — consumes this file, so the expensive part
 * (bars, storage metadata) is paid once.
 *
 * Two rules the record's shape enforces, because they're the ones that make or
 * break the feature:
 *
 *   1. EVERY NUMBER COMES FROM BARS. The image is never asked for a price. The
 *      `claim` block is what the trader asserted; the `truth` block is what the
 *      tape did. The model gets both and is only ever allowed to quote from
 *      `truth`.
 *
 *   2. THE FRAME IS GATED BEFORE IT IS READ. `frame` carries the storage
 *      object's upload time against the trade's entry and exit. A capture that
 *      landed after the exit is a HINDSIGHT image, and nothing about "what you
 *      could see at the decision" can honestly be read off it. This is the
 *      empirical answer to the OBS-auto-capture question — measured from
 *      storage metadata, not guessed from filenames (filenames are reported
 *      too, as a cross-check).
 *
 * Bar caveats, stated rather than hidden:
 *   - ATR prefers the stored `entry_atr_1m` (backfill-entry-metrics.ts streams
 *     it continuously across sessions). The bar-computed fallback seeds Wilder
 *     ATR-10 inside the fetched window, so it is slightly warm-start-biased;
 *     records say which source was used in `truth.atr_source`.
 *   - Session VWAP is computed from the RTH open (06:30 PT) forward on the
 *     day's own bars. Trades before the RTH open get a null VWAP rather than
 *     an overnight-anchored one that would mean something different.
 *   - Micro symbols fall back to the mini bar series (MNQ→NQ), same as
 *     backfill-post-exit.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(`--${n}`)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null

/** Include trades with NO verdict yet. The calibration set only exists once the
 *  trader has clicked through the Game film, but the TRUTH half of every record
 *  is computable today — so the bar/level/chase/frame pipeline can be built and
 *  checked against real trades before a single label exists. Records emitted
 *  this way carry `label.call: null` and must never be counted in a hit rate. */
const UNLABELLED = has('unlabelled')

const envName = argVal('env') ?? 'public'
const isProd = envName !== 'local'
const LIMIT = Number(argVal('limit') ?? '0') || 0
const OUT_DIR = argVal('out') ?? join(process.cwd(), 'evals', 'screenshot-coach')

// LIVE-FIRST: .env.public-feed points at prod; .env.local is the dev project.
// Values there are quote-wrapped — strip them.
for (const line of readFileSync(isProd ? '.env.public-feed' : '.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  (isProd ? process.env.PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  (isProd ? process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY)!,
  { auth: { persistSession: false } },
)

const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID

const SCREENSHOTS_BUCKET = 'screenshots'
const SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 7   // a week — long enough to iterate on the prompt
const PRE_BARS = 30                            // 1-min bars before entry
const POST_EXIT_WINDOW_MIN = 15                // keep in sync with POST_EXIT_WINDOW_MIN (src/lib/atr.ts)
const ATR_PERIOD = 10
const RTH_OPEN_SEC = 6 * 3600 + 30 * 60        // 06:30 PT

// ── PT wall-clock (DST-aware), built once: this runs per bar. ────────────────
const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})
function ptParts(ms: number): { date: string; sec: number; hhmm: string } {
  const p: Record<string, string> = {}
  for (const x of PT_FMT.formatToParts(new Date(ms))) p[x.type] = x.value
  const hour = p.hour === '24' ? 0 : parseInt(p.hour)
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    sec: hour * 3600 + parseInt(p.minute) * 60 + parseInt(p.second),
    hhmm: `${String(hour).padStart(2, '0')}:${p.minute}`,
  }
}
const ptStamp = (iso: string | null): string | null => {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  const { date, hhmm } = ptParts(ms)
  return `${date} ${hhmm} PT`
}

// ── bars ────────────────────────────────────────────────────────────────────
interface Bar { ts: string; open: number; high: number; low: number; close: number; volume: number | null }

const MICRO_TO_MINI: Record<string, string> = { MNQ: 'NQ', MES: 'ES', MYM: 'YM', M2K: 'RTY' }

/** Trades carry the decorated contract (`MNQU6.CME`); `ohlcv_bars` is keyed by
 *  the BARE mini root (`NQ`). Strip the exchange suffix, strip the month+year
 *  code, then fold micro→mini. Note the full month-code set — an earlier
 *  `[HMUZ]` only covered the quarterlies and left `MNQN6`-style symbols
 *  unresolved. */
const rootOf = (s: string) => s.replace(/\.[A-Z]+$/, '').replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '')
const barSymbol = (s: string): string => {
  const r = rootOf(s)
  return MICRO_TO_MINI[r] ?? r
}

async function fetchBars(symbol: string, startIso: string, endIso: string): Promise<Bar[]> {
  const out: Bar[] = []
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from('ohlcv_bars')
      .select('ts, open, high, low, close, volume')
      .eq('symbol', symbol)
      .gte('ts', startIso).lte('ts', endIso)
      .order('ts', { ascending: true })
      .range(p * 1000, p * 1000 + 999)
    if (error) throw error
    if (!data || !data.length) break
    out.push(...(data as Bar[]))
    if (data.length < 1000) break
  }
  return out
}

/** The day's bars plus the PRIOR day — the prior day is only there to warm the
 *  Wilder ATR seed, and to let a level's touch count start from the overnight. */
async function fetchDayBars(symbol: string, date: string): Promise<{ bars: Bar[]; symbolUsed: string | null }> {
  const start = new Date(`${date}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - 1)
  const end = new Date(`${date}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  const startIso = start.toISOString()
  const endIso = end.toISOString().slice(0, 10) + 'T23:59:59Z'

  const root = barSymbol(symbol)
  let bars = await fetchBars(root, startIso, endIso)
  if (bars.length) return { bars, symbolUsed: root }
  // Fall back to the decorated symbol in case a day was imported un-normalised.
  if (root !== symbol) {
    bars = await fetchBars(symbol, startIso, endIso)
    if (bars.length) return { bars, symbolUsed: symbol }
  }
  return { bars: [], symbolUsed: null }
}

/** Wilder ATR-10 streamed over the window, returned per bar index. */
function atrSeries(bars: Bar[]): Array<number | null> {
  const out: Array<number | null> = []
  let prevClose: number | null = null
  const seed: number[] = []
  let atr: number | null = null
  for (const b of bars) {
    const tr = prevClose == null
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
    if (atr == null) {
      seed.push(tr)
      if (seed.length === ATR_PERIOD) atr = seed.reduce((s, v) => s + v, 0) / ATR_PERIOD
    } else {
      atr = ((ATR_PERIOD - 1) * atr + tr) / ATR_PERIOD
    }
    prevClose = b.close
    out.push(atr)
  }
  return out
}

/** Session VWAP anchored at the RTH open (06:30 PT) of `date`, per bar index.
 *  Null for bars before the open — an overnight-anchored VWAP is a different
 *  reference and would quietly mean something else. */
/** EMA of 1-minute closes, per bar index. The trader's footprint pane runs a
 *  9 and a 20 EMA on the 1-minute; the coach may read an entry as sitting on
 *  one, so the truth has to carry where they were at the entry bar. */
function emaSeries(bars: Bar[], period: number): Array<number | null> {
  const k = 2 / (period + 1)
  let ema: number | null = null
  return bars.map((b, i) => {
    if (i < period - 1) return null
    if (ema == null) { ema = bars.slice(0, period).reduce((s, x) => s + x.close, 0) / period; return ema }
    ema = b.close * k + ema * (1 - k)
    return ema
  })
}

function vwapSeries(bars: Bar[], date: string): Array<number | null> {
  let pv = 0, vol = 0
  return bars.map(b => {
    const { date: bd, sec } = ptParts(new Date(b.ts).getTime())
    if (bd !== date || sec < RTH_OPEN_SEC) return null
    const typical = (b.high + b.low + b.close) / 3
    const v = Number.isFinite(b.volume as number) && b.volume ? b.volume : 0
    pv += typical * v
    vol += v
    return vol > 0 ? pv / vol : null
  })
}

/** Recover the bucket-relative storage path from whatever shape a row holds —
 *  bare path, legacy public URL, or signed URL. Mirrors screenshotStoragePath()
 *  in src/lib/storage-url.ts; kept local so the script has no '@/' import. */
function storagePathOf(value: string): string | null {
  for (const marker of [
    `/storage/v1/object/public/${SCREENSHOTS_BUCKET}/`,
    `/storage/v1/object/sign/${SCREENSHOTS_BUCKET}/`,
  ]) {
    const idx = value.indexOf(marker)
    if (idx !== -1) return decodeURIComponent(value.slice(idx + marker.length).split('?')[0])
  }
  if (/^https?:\/\//i.test(value)) return null   // a foreign URL — not ours to sign
  return value
}

// ── the record ──────────────────────────────────────────────────────────────
interface LevelRef {
  name: string
  price: number
  dist_pts: number
  /** In 1-minute ATR — the right unit for excursion, too fine for proximity. */
  dist_atr: number | null
  /** As a fraction of the day's ADR — the unit that actually means "at a level". */
  dist_adr: number | null
  side: 'above' | 'below' | 'at'
}

const round = (v: number | null | undefined, d = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d))

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`db=${isProd ? 'PROD (public)' : 'dev (local)'}  user=${USER_ID}  out=${OUT_DIR}\n`)

  // ── 1. the calibration set ────────────────────────────────────────────────
  let q = sb.from('trades')
    .select('id, trading_day_id, entry_time, exit_time, entry_price, exit_price, stop_price, tp1_price, ' +
            'direction, quantity, pnl, symbol, screenshot_url, high_during_position, low_during_position, ' +
            'post_exit_favorable_pts, post_exit_against_pts, structure_5m_alignment, entry_atr_1m, entry_rvol, ' +
            'exits_json, tags_json, notes, review_json')
    .eq('user_id', USER_ID)
    .order('entry_time', { ascending: false })
  // Unlabelled mode still needs a screenshot — a record with neither a label
  // nor an image has nothing for the coach to read.
  q = UNLABELLED ? q.not('screenshot_url', 'is', null) : q.not('review_json->verdict', 'is', null)
  if (LIMIT) q = q.limit(LIMIT)

  const { data: trades, error } = await q
  if (error) {
    if (error.code === '42703') {
      console.error('review_json column missing — apply supabase/migrations/20260814_trade_review.sql on this DB.')
      process.exit(1)
    }
    throw error
  }
  const rows = (trades ?? []) as Record<string, any>[]  // eslint-disable-line @typescript-eslint/no-explicit-any

  if (rows.length === 0) {
    console.log(UNLABELLED
      ? 'No trades with a screenshot found for this user.'
      : 'No verdict-labelled trades found. Label some in the weekly Game film first,\n' +
        'or re-run with --unlabelled to build the truth half against every screenshot trade.')
    return
  }

  // ── 2. day + context lookups ──────────────────────────────────────────────
  const dayIds = Array.from(new Set(rows.map(t => t.trading_day_id).filter(Boolean)))
  const { data: days } = await sb.from('trading_days').select('id, date').in('id', dayIds)
  const dayDate = new Map<string, string>((days ?? []).map((d: { id: string; date: string }) => [d.id, d.date]))

  // Keyed by day AND instrument root: a day can carry both an NQ and an ES
  // context row, and taking whichever came back first would hang NQ levels off
  // an ES trade. There is deliberately NO day-only fallback (see the strict
  // match note at the lookup site).
  const { data: ctxRows } = await sb.from('market_context')
    .select('trading_day_id, symbol, pdh, pdl, ibh, ibl, onh, onl, atr_1m, adr, rvol')
    .in('trading_day_id', dayIds)
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ctxByDaySym = new Map<string, Record<string, any>>()
  for (const c of ctxRows ?? []) {
    const k = `${c.trading_day_id}|${c.symbol ? barSymbol(c.symbol) : ''}`
    if (!ctxByDaySym.has(k)) ctxByDaySym.set(k, c)
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ── 3. storage metadata — the frame-integrity gate's evidence ─────────────
  //  One list() per {user}/trades folder gives every object's upload time; the
  //  question "was this capture taken at the decision or after it?" is then a
  //  subtraction, not a vision call.
  const uploadedAt = new Map<string, string>()
  const sizeOf = new Map<string, number>()
  for (let offset = 0; offset < 5000; offset += 100) {
    const { data: objs, error: lsErr } = await sb.storage.from(SCREENSHOTS_BUCKET)
      .list(`${USER_ID}/trades`, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
    if (lsErr || !objs || objs.length === 0) break
    for (const o of objs) {
      uploadedAt.set(`${USER_ID}/trades/${o.name}`, o.created_at ?? o.updated_at ?? '')
      if (o.metadata?.size) sizeOf.set(`${USER_ID}/trades/${o.name}`, o.metadata.size)
    }
    if (objs.length < 100) break
  }

  // Sign every screenshot in one batch, keyed by RECOVERED storage path. 86 of
  // the owner's rows hold a legacy absolute public URL rather than a path (the
  // local build persists public URLs against its public bucket) — signing only
  // the bare-path rows would have left more than half the set with no storage
  // metadata at all.
  const toSign = Array.from(new Set(
    rows.map(t => (t.screenshot_url ? storagePathOf(t.screenshot_url) : null))
      .filter((v: string | null): v is string => !!v),
  ))
  const signed = new Map<string, string>()
  for (let i = 0; i < toSign.length; i += 100) {
    const batch = toSign.slice(i, i + 100)
    const { data: sd } = await sb.storage.from(SCREENSHOTS_BUCKET).createSignedUrls(batch, SIGNED_URL_TTL_SEC)
    if (Array.isArray(sd)) sd.forEach((r: { signedUrl?: string | null }, j: number) => {
      if (r?.signedUrl) signed.set(batch[j], r.signedUrl)
    })
  }

  // ── 4. per-trade record ───────────────────────────────────────────────────
  const barCache = new Map<string, { bars: Bar[]; symbolUsed: string | null }>()
  const records: Record<string, unknown>[] = []
  const skipped: Array<{ id: string; why: string }> = []

  for (const t of rows) {
    const date = dayDate.get(t.trading_day_id) ?? null
    const entryMs = t.entry_time ? new Date(t.entry_time).getTime() : NaN
    if (!date || !Number.isFinite(entryMs) || t.entry_price == null || !t.direction) {
      skipped.push({ id: t.id, why: 'no date / entry_time / entry_price / direction' })
      continue
    }
    const symbol: string = t.symbol ?? 'NQ'
    const cacheKey = `${symbol}|${date}`
    if (!barCache.has(cacheKey)) barCache.set(cacheKey, await fetchDayBars(symbol, date))
    const { bars, symbolUsed } = barCache.get(cacheKey)!

    const isLong = t.direction === 'long'
    const entry: number = t.entry_price
    const exitMs = t.exit_time ? new Date(t.exit_time).getTime() : NaN

    // Index of the last bar at or before entry.
    let entryIdx = -1
    for (let i = 0; i < bars.length; i++) {
      if (new Date(bars[i].ts).getTime() <= entryMs) entryIdx = i; else break
    }

    // ── bar space vs contract space ────────────────────────────────────────
    //  `ohlcv_bars` is a CONTINUOUS front-month series; the trade carries its
    //  own contract (MNQM6). Subtracting one from the other doesn't cancel the
    //  roll basis — a 2026-06-15 MNQM6 long came out 288 points "below" every
    //  bar in its own lookback, which read as a −288pt chase.
    //
    //  So everything bar-derived is anchored on the ENTRY BAR's close and
    //  measured bar-to-bar, exactly as the tick excursion fix anchors on entry
    //  so the MNQ/NQ basis cancels. Contract-space values (entry/stop/tp1/exit)
    //  stay in contract space, where they're mutually consistent.
    const entryBar = entryIdx >= 0 ? bars[entryIdx].close : null
    const basisPts = entryBar != null ? round(t.entry_price - entryBar) : null
    // A basis that isn't a roll basis means the bars aren't this trade's
    // instrument at all (one row carries an NQ-scale entry under an MES
    // symbol). Beyond 5% nothing bar-derived can be trusted, so it is dropped
    // rather than reported.
    const scaleMismatch = entryBar != null && Math.abs(t.entry_price - entryBar) / entryBar > 0.05
    const usableBars = entryIdx >= 0 && !scaleMismatch

    const atrs = bars.length ? atrSeries(bars) : []
    const vwaps = bars.length ? vwapSeries(bars, date) : []
    const ema9s = bars.length ? emaSeries(bars, 9) : []
    const ema20s = bars.length ? emaSeries(bars, 20) : []
    const barAtr = entryIdx >= 0 ? atrs[entryIdx] : null
    const atr: number | null = t.entry_atr_1m ?? barAtr
    const atrSource = t.entry_atr_1m != null ? 'entry_atr_1m' : (barAtr != null ? 'bars' : 'none')
    const inAtr = (pts: number | null): number | null =>
      pts == null || atr == null || atr <= 0 ? null : round(pts / atr)

    // ── truth: entry location vs reference levels ──────────────────────────
    //  Levels come from market_context, which is computed off the SAME bar
    //  feed — so they are compared against the entry BAR, not the contract's
    //  entry price. `adr` is carried alongside because 1-minute ATR is the
    //  wrong yardstick for "was this at a level": at ~1.5pt on ES it makes an
    //  ordinary 13-point gap read as nine ATR. Distance is reported in both,
    //  and the day-scale one is the one that means "near".
    // STRICT instrument match. The earlier day-keyed fallback let an ES row
    // serve an NQ trade: its levels were (rightly) dropped by the scale guard,
    // but its ADR was still borrowed as the proximity denominator, and
    // `context_matched` read true because VWAP — computed from the trade's
    // OWN bars — always survives. A context row for another instrument is
    // not partial context; it is no context.
    const ctxRow = ctxByDaySym.get(`${t.trading_day_id}|${barSymbol(symbol)}`) ?? null
    const ctx = ctxRow ?? {}
    const adr: number | null = ctxRow && Number.isFinite(ctxRow.adr) ? ctxRow.adr : null
    const inAdr = (pts: number | null): number | null =>
      pts == null || adr == null || adr <= 0 ? null : round(pts / adr, 3)
    const vwapAtEntry = usableBars ? vwaps[entryIdx] : null
    const ema9AtEntry = usableBars ? ema9s[entryIdx] : null
    const ema20AtEntry = usableBars ? ema20s[entryIdx] : null
    // IB EXTENSIONS. The trader's chart labels IBH +50/+100% and IBL −50/−100%
    // and the coach's blind read of an entry sitting on "IBL −100%" was
    // scored against a truth that didn't carry it — the read could not have
    // been confirmed even when right. Derived from the IB range, so they are
    // exactly as reliable as ibh/ibl.
    const ibRange = ctx.ibh != null && ctx.ibl != null ? ctx.ibh - ctx.ibl : null
    const candidates: Array<[string, number | null]> = [
      ['IB high', ctx.ibh ?? null], ['IB low', ctx.ibl ?? null],
      ['PDH', ctx.pdh ?? null], ['PDL', ctx.pdl ?? null],
      ['ON high', ctx.onh ?? null], ['ON low', ctx.onl ?? null],
      ['IBH +50%', ibRange != null ? ctx.ibh + ibRange * 0.5 : null],
      ['IBH +100%', ibRange != null ? ctx.ibh + ibRange : null],
      ['IBL -50%', ibRange != null ? ctx.ibl - ibRange * 0.5 : null],
      ['IBL -100%', ibRange != null ? ctx.ibl - ibRange : null],
      ['VWAP', vwapAtEntry],
      ['EMA 9', ema9AtEntry], ['EMA 20', ema20AtEntry],
    ]
    const levels: LevelRef[] = []
    if (usableBars && entryBar != null) {
      for (const [name, price] of candidates) {
        if (price == null || !Number.isFinite(price)) continue
        // Scale guard on the LEVELS themselves. The day-keyed fallback above
        // can hand back another instrument's context row when the symbol key
        // misses, which put a level 327 ADR away from the entry. A reference
        // level more than 20% from the entry bar isn't a level, it's a
        // different product.
        if (Math.abs(entryBar - price) / entryBar > 0.2) continue
        const d = entryBar - price
        levels.push({
          name, price: round(price)!,
          dist_pts: round(Math.abs(d))!,
          dist_atr: inAtr(Math.abs(d)),
          dist_adr: inAdr(Math.abs(d)),
          side: Math.abs(d) < 1e-9 ? 'at' : d > 0 ? 'above' : 'below',
        })
      }
      levels.sort((a, b) => a.dist_pts - b.dist_pts)
    }
    // VWAP is excluded from "nearest": price spends the session oscillating
    // across it, so it wins the proximity contest on most trades (58 of 154)
    // and buries the structural level the trade was actually about. It stays
    // in `all`, and its side is reported on its own.
    // Moving lines (VWAP, EMAs) are excluded from "nearest" for the same
    // reason as VWAP always was: price lives on them, so they win proximity
    // on most trades and bury the structural level. Reported on the side.
    const MOVING = new Set(['VWAP', 'EMA 9', 'EMA 20'])
    const nearest = levels.find(l => !MOVING.has(l.name)) ?? null
    const vwapRef = levels.find(l => l.name === 'VWAP') ?? null
    const ema9Ref = levels.find(l => l.name === 'EMA 9') ?? null
    const ema20Ref = levels.find(l => l.name === 'EMA 20') ?? null

    // How many times before entry did price visit that level? Counted with
    // HYSTERESIS — price must clear the band by a full ATR before the next
    // visit counts. Without it, a level being hovered returns "29 touches",
    // which is a description of chop, not of the level's freshness.
    //  Counted from the START OF THIS TRADING DATE only. The fetched window
    //  reaches back a day to warm the ATR seed, and letting the counter run
    //  over it charged every PDH/PDL with the whole prior session's visits —
    //  a level was "touched 32 times" before a trade that was its first of the
    //  day.
    let touchesBefore: number | null = null
    if (nearest && atr && usableBars) {
      const band = 0.15 * atr
      const clear = 1.0 * atr
      let touches = 0, inside = false
      let dayStart = 0
      while (dayStart <= entryIdx && ptParts(new Date(bars[dayStart].ts).getTime()).date !== date) dayStart++
      for (let i = dayStart; i <= entryIdx; i++) {
        const b = bars[i]
        if (b.high >= nearest.price - band && b.low <= nearest.price + band) {
          if (!inside) { touches++; inside = true }
        } else if (b.low > nearest.price + clear || b.high < nearest.price - clear) {
          inside = false
        }
      }
      touchesBefore = touches
    }

    // ── truth: chase / timing ─────────────────────────────────────────────
    //  How far had the leg ALREADY run when the entry printed — from the
    //  opposite extreme of the prior 30 bars to the entry BAR. A long entered
    //  2xATR above the last swing low is a chase whatever the tag says.
    let chasePts: number | null = null
    let legOrigin: number | null = null
    if (usableBars && entryBar != null) {
      const from = Math.max(0, entryIdx - PRE_BARS + 1)
      let ext = isLong ? Infinity : -Infinity
      for (let i = from; i <= entryIdx; i++) {
        if (isLong) ext = Math.min(ext, bars[i].low)
        else ext = Math.max(ext, bars[i].high)
      }
      if (Number.isFinite(ext)) {
        legOrigin = round(ext)
        // Clamped at 0: the entry bar's own low/high is in the window, so a
        // negative run would mean the extreme sat the wrong side of the entry
        // bar — impossible now that both are bar-space.
        chasePts = round(Math.max(0, isLong ? entryBar - ext : ext - entryBar))
      }
    }

    // ── truth: exit ───────────────────────────────────────────────────────
    //  high/low_during_position are contract-space, so they pair with the
    //  contract-space entry. Two rows don't bracket their own entry (a −0.75pt
    //  "MFE"); an excursion that never happened is nulled, not reported
    //  negative — a downstream reader would take the sign at face value.
    const hi = t.high_during_position, lo = t.low_during_position
    const bracketsEntry = hi != null && lo != null && hi >= entry && lo <= entry
    const mfePts = bracketsEntry ? round(isLong ? hi - entry : entry - lo) : null
    const maePts = bracketsEntry ? round(isLong ? entry - lo : hi - entry) : null
    const realizedPts = t.exit_price != null ? round(isLong ? t.exit_price - entry : entry - t.exit_price) : null
    // Capture on the POINTS basis, clamped at 100% — the >100% readings that
    // burned the per-leg fix came from a numerator the denominator can't bound.
    const capturePct = mfePts != null && mfePts > 0 && realizedPts != null
      ? round(Math.min(100, Math.max(0, (realizedPts / mfePts) * 100)), 1)
      : null
    const riskPts = t.stop_price != null ? round(Math.abs(entry - t.stop_price)) : null
    const rMultiple = riskPts != null && riskPts > 0 && realizedPts != null
      ? round(realizedPts / riskPts) : null

    // ── truth: bar strip ──────────────────────────────────────────────────
    //  +/-30 1-min bars around entry, plus the exit bar and the 15 minutes
    //  after it. Compact tuples: the model reads shape, never prices it hasn't
    //  been handed.
    const stripFrom = Math.max(0, entryIdx - PRE_BARS)
    const stripTo = Math.min(bars.length - 1, entryIdx + PRE_BARS)
    const strip = usableBars ? bars.slice(stripFrom, stripTo + 1).map(b => {
      const { hhmm } = ptParts(new Date(b.ts).getTime())
      return [hhmm, round(b.open), round(b.high), round(b.low), round(b.close), b.volume ?? 0]
    }) : []

    let postExitStrip: unknown[] = []
    if (usableBars && Number.isFinite(exitMs)) {
      const endMs = exitMs + POST_EXIT_WINDOW_MIN * 60_000
      postExitStrip = bars
        .filter(b => { const ms = new Date(b.ts).getTime(); return ms > exitMs && ms <= endMs })
        .map(b => {
          const { hhmm } = ptParts(new Date(b.ts).getTime())
          return [hhmm, round(b.open), round(b.high), round(b.low), round(b.close), b.volume ?? 0]
        })
    }

    // ── the frame gate's evidence ─────────────────────────────────────────
    //  MEASURED, and the measurement came back negative: neither the storage
    //  upload time nor the epoch in the filename is a CAPTURE time. Both are
    //  WRITE times, and they arrive in batches — five 2026-08-14 trades with
    //  entries spread over 16 minutes carry file epochs that all land within
    //  seconds of 10:08 PT. OBS rows run from 14 minutes to 26 HOURS after the
    //  entry. So a write time cannot tell us what the chart showed.
    //
    //  It bounds the capture in ONE direction only: capture <= write. A file
    //  written BEFORE the exit therefore proves the image predates the exit,
    //  and that is the only verdict this metadata can support. Everything else
    //  is `unknown` — the gate itself has to be a vision call on how much
    //  chart sits to the right of the entry marker.
    const rawShot: string | null = t.screenshot_url ?? null
    const shotPath = rawShot ? storagePathOf(rawShot) : null
    const upIso = shotPath ? (uploadedAt.get(shotPath) || null) : null
    const upMs = upIso ? new Date(upIso).getTime() : NaN
    // The 13-digit epoch the uploader stamps into the filename. Earlier than
    // the storage upload time, so it's the tighter of the two bounds.
    const nameEpoch = shotPath ? Number(shotPath.match(/(\d{13})\.(?:jpe?g|png|webp)$/i)?.[1] ?? NaN) : NaN
    const writeMs = Math.min(
      Number.isFinite(nameEpoch) ? nameEpoch : Infinity,
      Number.isFinite(upMs) ? upMs : Infinity,
    )
    const haveWrite = Number.isFinite(writeMs)
    const minsFromEntry = haveWrite ? round((writeMs - entryMs) / 60_000, 1) : null
    const minsFromExit = haveWrite && Number.isFinite(exitMs)
      ? round((writeMs - exitMs) / 60_000, 1) : null
    // The uploader's own prefix, not a guess: OBS auto-captures are written as
    // `obs-<uuid>-<epoch>.jpg`, manual saves as `<date>-<epoch>.png`.
    const isObs = shotPath ? /\/obs-/.test(shotPath) : null

    const tags = (t.tags_json ?? {}) as Record<string, string[] | string | undefined>
    const norm = (v: string[] | string | undefined): string[] =>
      v == null ? [] : Array.isArray(v) ? v : [v]

    records.push({
      trade_id: t.id,
      date,
      entry_pt: ptStamp(t.entry_time),
      exit_pt: ptStamp(t.exit_time),
      symbol,
      bar_symbol: symbolUsed,
      direction: t.direction,
      quantity: t.quantity,

      // What the trader ASSERTED. The model may check these against `truth`.
      claim: {
        setups: norm(tags.setups),
        confluences: norm(tags.confluences),
        order_flow: norm(tags.order_flow),
        entry_model: norm(tags.entry_model),
        trade_management: norm(tags.trade_management),
        mistakes: norm(tags.mistakes),
        emotions: norm(tags.emotions),
        read: t.notes ?? null,
      },

      // What the trader LABELLED it, in hindsight. The calibration target —
      // NEVER shown to the model.
      label: {
        call: t.review_json?.verdict?.call ?? null,
        note: t.review_json?.verdict?.note ?? null,
        at: t.review_json?.verdict?.at ?? null,
      },

      // The gate. Read this before reading the image.
      frame: {
        signed_url: rawShot ? (signed.get(shotPath ?? rawShot) ?? rawShot) : null,
        storage_path: shotPath,
        capture_source: isObs == null ? null : isObs ? 'obs' : 'manual',
        uploaded_at: upIso,
        /** Earliest write time we can prove, from the filename epoch or the
         *  storage upload, whichever is earlier. NOT a capture time. */
        written_at_mins_after_entry: minsFromEntry,
        written_at_mins_after_exit: minsFromExit,
        /** Two independent proofs that the image predates the exit:
         *   - metadata: written before the exit, so it cannot contain
         *     post-exit bars (the only thing a write time can establish);
         *   - construction: OBS auto-captures fire AT ENTRY (owner-confirmed
         *     2026-08-16; the full recording holds the exit, but the still
         *     is the entry frame). Write time is irrelevant for those.
         *  `false` means UNKNOWN, not "hindsight" — see the note above. */
        proven_pre_exit: isObs === true || (minsFromExit != null && minsFromExit <= 0),
        pre_exit_basis: isObs === true ? 'obs_fires_at_entry'
          : (minsFromExit != null && minsFromExit <= 0) ? 'written_before_exit' : null,
        bytes: shotPath ? (sizeOf.get(shotPath) ?? null) : null,
      },

      // What the tape did. The ONLY place numbers may be quoted from.
      truth: {
        entry_price: round(entry),
        exit_price: round(t.exit_price),
        stop_price: round(t.stop_price),
        tp1_price: round(t.tp1_price),
        atr_1m: round(atr),
        atr_source: atrSource,
        adr: round(adr),
        entry_rvol: round(t.entry_rvol, 1),

        /** Bar-feed health for THIS trade. `basis_pts` is the contract-vs-
         *  continuous roll offset (small = normal); `scale_mismatch` means the
         *  bars aren't this instrument and every bar-derived field below is
         *  null by design. */
        bar_basis: {
          entry_bar_close: round(entryBar),
          basis_pts: basisPts,
          scale_mismatch: scaleMismatch,
        },

        location: {
          nearest: nearest,
          vwap: vwapRef,
          ema9: ema9Ref, ema20: ema20Ref,
          all: levels,
          touches_before_entry: touchesBefore,
          /** Which market_context row backed these levels, and whether it is
           *  actually this trade's instrument. `market_context.symbol` is
           *  polluted with parse garbage ("5", "Trade", "S@30805.00") and on
           *  several MES days the only row is NQ — so a level set that does
           *  not match is dropped, and axis 1 must return n/a rather than
           *  compare an ES entry to NQ levels. */
          context_symbol: ctxRow?.symbol ?? null,
          /** A populated context row exists for THIS trade's instrument. VWAP
           *  doesn't count — it comes from the trade's own bars, not the row. */
          context_matched: ctxRow != null && levels.some(l => !MOVING.has(l.name)),
        },
        structure: {
          alignment_5m: t.structure_5m_alignment ?? null,
        },
        chase: {
          leg_origin_price: legOrigin,
          run_before_entry_pts: chasePts,
          run_before_entry_atr: inAtr(chasePts),
          run_before_entry_adr: inAdr(chasePts),
          lookback_bars: PRE_BARS,
        },
        exit: {
          pnl: t.pnl ?? null,
          realized_pts: realizedPts,
          r_multiple: rMultiple,
          risk_pts: riskPts,
          mfe_pts: mfePts, mfe_atr: inAtr(mfePts),
          mae_pts: maePts, mae_atr: inAtr(maePts),
          capture_pct: capturePct,
          post_exit_favorable_pts: round(t.post_exit_favorable_pts),
          post_exit_favorable_atr: inAtr(t.post_exit_favorable_pts),
          post_exit_against_pts: round(t.post_exit_against_pts),
          post_exit_against_atr: inAtr(t.post_exit_against_pts),
          scaled_out: Array.isArray(t.exits_json) && t.exits_json.length > 1,
          legs: Array.isArray(t.exits_json) ? t.exits_json.length : null,
        },
        bars: {
          /** [hh:mm PT, o, h, l, c, v] — entry is at index `entry_offset`. */
          strip: strip,
          entry_offset: entryIdx >= 0 ? entryIdx - stripFrom : null,
          post_exit: postExitStrip,
        },
      },
    })
  }

  // ── 5. write + the step-0 report ──────────────────────────────────────────
  const jsonlPath = join(OUT_DIR, UNLABELLED ? 'unlabelled-trades.jsonl' : 'labelled-trades.jsonl')
  writeFileSync(jsonlPath, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const n = records.length
  const withShot = records.filter(r => (r.frame as any).signed_url).length            // eslint-disable-line @typescript-eslint/no-explicit-any
  const withBars = records.filter(r => ((r.truth as any).bars.strip as unknown[]).length > 0).length  // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls: Record<string, number> = {}
  for (const r of records) {
    const c = (r.label as { call: string | null }).call ?? 'none'
    calls[c] = (calls[c] ?? 0) + 1
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const frameTimed = records.filter(r => (r.frame as any).written_at_mins_after_exit != null)
  const provenPre = records.filter(r => (r.frame as any).proven_pre_exit).length
  const provenByObs = records.filter(r => (r.frame as any).pre_exit_basis === 'obs_fires_at_entry').length
  const provenByWrite = records.filter(r => (r.frame as any).pre_exit_basis === 'written_before_exit').length
  const obsCount = records.filter(r => (r.frame as any).capture_source === 'obs').length
  const manualCount = records.filter(r => (r.frame as any).capture_source === 'manual').length
  const noBars = records.filter(r => ((r.truth as any).bars.strip as unknown[]).length === 0)
    .map(r => `${r.date} ${r.symbol}`)
  const mismatched = records.filter(r => (r.truth as any).bar_basis.scale_mismatch).length
  const noLevels = records.filter(r => (r.truth as any).location.nearest == null).length
  const noExcursion = records.filter(r => (r.truth as any).exit.mfe_pts == null).length
  const basisAbs = records
    .map(r => (r.truth as any).bar_basis.basis_pts)
    .filter((v: number | null): v is number => v != null).map(Math.abs).sort((a, b) => a - b)
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const basisP50 = basisAbs.length ? basisAbs[Math.floor(basisAbs.length / 2)] : null
  const basisMax = basisAbs.length ? basisAbs[basisAbs.length - 1] : null
  const withStop = records.filter(r => (r.truth as any).stop_price != null).length     // eslint-disable-line @typescript-eslint/no-explicit-any
  const withCapture = records.filter(r => (r.truth as any).exit.capture_pct != null).length // eslint-disable-line @typescript-eslint/no-explicit-any

  const report = [
    `SCREENSHOT-COACH HARNESS — step 0 report`,
    `db=${isProd ? 'PROD' : 'dev'}  user=${USER_ID}`,
    ``,
    UNLABELLED ? `TRUTH-ONLY SET  (--unlabelled: no calibration labels in this file)` : `CALIBRATION SET`,
    `  trades pulled                ${n}${LIMIT ? ` (--limit=${LIMIT})` : ''}`,
    `  verdicts                     ${Object.entries(calls).map(([k, v]) => `${k}=${v}`).join('  ')}`,
    `  skipped (unusable rows)      ${skipped.length}`,
    UNLABELLED
      ? `  >> NOT SCOREABLE. Step 4 needs verdicts from the weekly Game film.`
      : n < 40
        ? `  >> UNDER 40 — scoring in step 4 is DIRECTIONAL ONLY, not a hit rate.`
        : `  >> enough for a real agreement rate.`,
    ``,
    `FRAME INTEGRITY  (the OBS question — metadata CANNOT answer it)`,
    `  with a screenshot             ${withShot} / ${n}`,
    `  OBS auto-capture              ${obsCount}`,
    `  manual save                   ${manualCount}`,
    `  with a write time at all      ${frameTimed.length}`,
    `  PROVEN pre-exit               ${provenPre} / ${n}   (${provenByObs} OBS fire at entry, ${provenByWrite} written before exit)`,
    `  unknown                       ${n - provenPre}   << manual saves with a post-exit write time; UNKNOWN, not hindsight`,
    `  >> Write times arrive in BATCHES (entries 16 min apart share one file`,
    `     epoch to the second) and OBS rows run 14 min to 26 h after entry, so`,
    `     no write time is a capture time. The gate must be a VISION call on how`,
    `     much chart sits right of the entry marker.`,
    ``,
    `TRUTH COVERAGE`,
    `  bar strip present             ${withBars} / ${n}`,
    `  stop logged (R + exit axis)   ${withStop} / ${n}`,
    `  capture computable            ${withCapture} / ${n}`,
    `  reference level resolved      ${n - noLevels} / ${n}   << ${noLevels} have no usable market_context (wrong instrument or garbage symbol)`,
    `  excursion brackets its entry  ${n - noExcursion} / ${n}`,
    noBars.length ? `  no bars for: ${Array.from(new Set(noBars)).slice(0, 12).join(', ')}` : `  bar coverage complete`,
    ``,
    `BAR BASIS  (contract vs continuous feed)`,
    `  roll basis |pts|              p50 ${basisP50 ?? '—'}   max ${basisMax ?? '—'}`,
    `  scale mismatches dropped      ${mismatched}  << bars are not this instrument; bar-derived fields nulled`,
    ``,
    `wrote ${jsonlPath}`,
  ].join('\n')

  writeFileSync(join(OUT_DIR, 'step0-report.txt'), report + '\n', 'utf8')
  console.log(report)
  if (skipped.length) {
    console.log(`\nskipped:`)
    for (const s of skipped.slice(0, 20)) console.log(`  ${s.id}  ${s.why}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
