/**
 * Screenshot coach — the coach's OWN read, verified against the tape.
 *
 *   npx tsx scripts/screenshot-coach-read.ts --limit=8 --spread
 *   npx tsx scripts/screenshot-coach-read.ts --limit=40
 *   npx tsx scripts/screenshot-coach-read.ts --dry
 *
 * Supersedes screenshot-coach-grade.ts. That version treated the trader's
 * tags as the claim and only asked whether the bars supported it — so an
 * untagged trade got nothing, and the trader's view framed every verdict.
 * The trader's direction (2026-08-16): the coach should look at the image and
 * form its OWN read, bump that against the SCID/bar truth to verify itself,
 * and treat the trader's tags as a low-weight reference to be checked, never
 * as the frame.
 *
 * Three passes per trade:
 *
 *   1. BLIND READ (model, image only). No tags, no note, no bars. The model
 *      says what kind of trade it sees, which reference level is in play,
 *      which way the larger structure runs, how far the leg had already
 *      gone, and what the footprint shows. Every field is CATEGORICAL —
 *      which level, which side, fresh vs extended — never a price, because a
 *      price is the one thing vision demonstrably misreads on these charts.
 *
 *   2. VERIFY (code, no model). Each categorical element is mapped onto the
 *      harness truth and marked confirmed / contradicted / partial /
 *      unverifiable. Level-in-play vs truth.location; direction vs the 5m
 *      alignment; timing vs the chase band. Footprint reads have no bar
 *      counterpart and stay "unverifiable" — reported, never asserted.
 *
 *   3. WRITE-UP (model, image + blind read + verification + truth numbers +
 *      the trader's tags marked REFERENCE ONLY). The coach states its read
 *      as corrected by the tape — contradicted elements are DROPPED, not
 *      hedged — quotes numbers only from truth, then says in one line where
 *      the trader's tags disagree with the verified read.
 *
 * What this measures without any labels: per-element confirm rates across
 * trades = how far each kind of image read can be trusted, learned from this
 * trader's own charts. Plus the fabrication check on every sentence.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import Anthropic from '@anthropic-ai/sdk'

const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(`--${n}`)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null

const IN_PATH = argVal('in') ?? join(process.cwd(), 'evals', 'screenshot-coach', 'unlabelled-trades.jsonl')
const LIMIT = Number(argVal('limit') ?? '3') || 3
const MODEL = argVal('model') ?? 'claude-sonnet-5'
const DRY = has('dry')
const SPREAD = has('spread')
const ANCHORED_PATH = join(dirname(IN_PATH), 'anchored-ids.json')

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const anthropic = new Anthropic()

// ── bands (single source; mirrors docs/screenshot-coach-rubric.md) ────────
const BANDS = { location_adr: { at: 0.05, near: 0.15 }, chase_atr: { early: 1.0, extended: 3.0 }, mfe_noise_atr: 0.5 }
type LocBand = 'at_level' | 'near' | 'in_space' | null
type ChaseBand = 'early' | 'mid' | 'extended' | null
const locBand = (adr: number | null): LocBand =>
  adr == null ? null : adr <= BANDS.location_adr.at ? 'at_level' : adr <= BANDS.location_adr.near ? 'near' : 'in_space'
const chaseBand = (atr: number | null): ChaseBand =>
  atr == null ? null : atr <= BANDS.chase_atr.early ? 'early' : atr <= BANDS.chase_atr.extended ? 'mid' : 'extended'

// ── PASS 1: blind read ────────────────────────────────────────────────────
const LEVELS = ['IB high', 'IB low', 'IBH +50%', 'IBH +100%', 'IBL -50%', 'IBL -100%', 'PDH', 'PDL', 'ON high', 'ON low', 'VWAP', 'EMA 9', 'EMA 20', 'RTH open', 'drawn level', 'none'] as const

const BLIND_PROMPT = `You are reading a futures trader's chart screenshot, captured around the moment they entered a trade. Sierra Chart. The usual layout: a 1-minute footprint (order-flow) pane on the left with a 9 and 20 EMA drawn on it; a bubble/delta pane top-right; a 5-minute candle pane bottom-right with volume profile, EMAs, and the session levels labelled on its right axis.

Give YOUR read of what this trade is, from the chart alone. You have not been told what the trader thinks it is, and you will not be. Read it the way an experienced tape reader would, glancing at a colleague's screen.

On numbers: the categorical fields below (which level, which way, fresh/extended) carry no prices. Separately, in price_reads, you MAY read prices off the chart — but ONLY as anchored reads that can be checked: a price paired with the minute it belongs to (from the x-axis), or a labelled level's price from the right axis, or the bracket-order prices on their tags, or a level the trader drew. Every one will be looked up in the 1-minute bar record for that minute (or matched to the known session levels), and a read that isn't there is discarded. Read the digits exactly as printed; do not round, do not estimate between gridlines. If you can't read the digits, don't include the read.

How to read Sierra's own markup on this trader's charts — get these right or everything downstream is wrong:
- THE POSITION LINE reads "+N | P/L: …" or "-N | P/L: …". +N means LONG N contracts, -N means SHORT N. This is the direction. It is also usually the entry level.
- THE ORDER TAGS ("S|Lmt|Open", "S|Stop|Open", "B|Lmt…", "B|Stop…") are the trader's EXIT orders — the bracket. A LONG position is bracketed by two SELL orders (a sell limit above = target, a sell stop below = stop). A SHORT is bracketed by two BUY orders. So the letter on the order tags is the OPPOSITE of the position's direction. Never infer direction from the order tags.
- LEVEL LABELS on the right axis: "IBH"/"IBL" are the initial-balance high/low. "IBH +50%", "IBH +100%", "IBL -50%", "IBL -100%" are IB EXTENSION levels — a different level from IBH/IBL, at that fraction of the IB range beyond it. "PDH"/"PDL" prior-day high/low. "ONH"/"ONL" overnight high/low. "VWAP", "RTH Open", "9 EMA", "20 EMA". Read the label nearest the entry exactly; "IBL -100%" is not "IB low".

Every field has an "unclear"/"none"/"nothing_notable" option. Use it whenever you would be guessing. Your read is about to be checked against the actual bars element by element, and a wrong element is dropped — a confident wrong read is worse than "unclear".

Calibration, from checking many of these charts: most entries are NOT extended, and most footprint panes at the entry show nothing decisive. If you find yourself answering "extended" or naming a footprint signal on every chart, you are pattern-filling, not reading. "fresh" and "nothing_notable" are the common honest answers.

Fields:
- direction: long or short, from the position line's sign (+N / -N). "unclear" only if no position line is visible.
- level_in_play: the labelled level the entry is AT or within a few ticks of. Read the label exactly (extension levels are their own entries). "drawn level" = a horizontal the trader drew with no label. "none" = open space between levels.
- level_side: entry sits above / below / at that level (relative to the level, not the trade).
- structure: on the 5-minute candle pane, is the larger move up, down, or range-bound?
- with_or_against: is the trade in the direction of that structure (with) or against it (against)? "n/a" if structure is range/unclear.
- timing: had the current leg ALREADY travelled far from its last swing when the entry printed (extended), or is the entry near the start of a leg / at a fresh test of the level (fresh)? Default to fresh unless the run is obviously long.
- trade_type: your synthesis — reversal_at_level / continuation_pullback / breakout / range_fade / unclear.
- footprint: what the order-flow pane shows AT the entry bar, if anything decisive: absorption / exhaustion / delta_divergence / imbalance_stack / nothing_notable / no_pane. Cannot be checked against bars; reported as your observation only.
- entry_marker_confidence: how sure you are you found the position line (high/medium/low/none).
- price_reads: zero or more anchored price reads, each {kind, price, time, label}. kinds: "position_line" (the price on the +N/-N line — the entry), "stop_order" / "target_order" (the S|Stop / S|Lmt / B|… tag prices), "level_label" (a labelled session level's price from the right axis — put the label text as printed in label, e.g. "IBL -100%"), "drawn_level" (a horizontal the trader drew; time null), "bar_extreme" (a specific candle's high or low you want to cite, WITH its x-axis minute as HH:MM in time). Only include reads whose digits you can actually see.
- note: ONE sentence, what you see, in words — the numbers go in price_reads.`

const BLIND_SCHEMA = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['long', 'short', 'unclear'] },
    level_in_play: { type: 'string', enum: [...LEVELS] },
    level_side: { type: 'string', enum: ['above', 'below', 'at', 'n/a'] },
    structure: { type: 'string', enum: ['up', 'down', 'range', 'unclear'] },
    with_or_against: { type: 'string', enum: ['with', 'against', 'n/a'] },
    timing: { type: 'string', enum: ['fresh', 'extended', 'unclear'] },
    trade_type: { type: 'string', enum: ['reversal_at_level', 'continuation_pullback', 'breakout', 'range_fade', 'unclear'] },
    footprint: { type: 'string', enum: ['absorption', 'exhaustion', 'delta_divergence', 'imbalance_stack', 'nothing_notable', 'no_pane'] },
    entry_marker_confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    price_reads: { type: 'array', items: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['position_line', 'stop_order', 'target_order', 'level_label', 'drawn_level', 'bar_extreme'] },
        price: { type: 'number' },
        time: { type: ['string', 'null'] },
        label: { type: ['string', 'null'] },
      },
      required: ['kind', 'price', 'time', 'label'], additionalProperties: false,
    } },
    note: { type: 'string' },
  },
  required: ['direction', 'level_in_play', 'level_side', 'structure', 'with_or_against', 'timing', 'trade_type', 'footprint', 'entry_marker_confidence', 'price_reads', 'note'],
  additionalProperties: false,
} as const

interface BlindRead {
  direction: 'long' | 'short' | 'unclear'
  level_in_play: typeof LEVELS[number]
  level_side: 'above' | 'below' | 'at' | 'n/a'
  structure: 'up' | 'down' | 'range' | 'unclear'
  with_or_against: 'with' | 'against' | 'n/a'
  timing: 'fresh' | 'extended' | 'unclear'
  trade_type: 'reversal_at_level' | 'continuation_pullback' | 'breakout' | 'range_fade' | 'unclear'
  footprint: 'absorption' | 'exhaustion' | 'delta_divergence' | 'imbalance_stack' | 'nothing_notable' | 'no_pane'
  entry_marker_confidence: 'high' | 'medium' | 'low' | 'none'
  price_reads: PriceRead[]
  note: string
}
interface PriceRead { kind: 'position_line' | 'stop_order' | 'target_order' | 'level_label' | 'drawn_level' | 'bar_extreme'; price: number; time: string | null; label: string | null }
interface PriceCheck extends PriceRead { status: 'confirmed' | 'contradicted' | 'unverifiable'; against: string; dist_atr_from_entry: number | null; touches: number | null }

// ── PASS 2: verify (code) ─────────────────────────────────────────────────
type V = 'confirmed' | 'contradicted' | 'partial' | 'unverifiable' | 'not_read'
interface Verification {
  direction: { status: V; truth: string | null }
  level_in_play: { status: V; truth: string | null }
  with_or_against: { status: V; truth: string | null }
  timing: { status: V; truth: string | null }
  footprint: { status: V; truth: string | null }
  price_reads: PriceCheck[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function verify(b: BlindRead, r: any): Verification {
  const t = r.truth
  const near = t.location.nearest
  const band = locBand(near?.dist_adr ?? null)
  const align: string | null = t.structure.alignment_5m
  const chase = chaseBand(t.chase.run_before_entry_atr)

  // direction — the fill knows.
  const direction = b.direction === 'unclear'
    ? { status: 'not_read' as V, truth: r.direction }
    : { status: (b.direction === r.direction ? 'confirmed' : 'contradicted') as V, truth: r.direction }

  // level — which reference level, and is the entry actually near it.
  // Moving lines (VWAP/EMAs) are checked against their own distance, in 1m ATR
  // (they sit ON price, so ADR is the wrong scale). Static levels use the
  // nearest-structural-level band in ADR.
  let level: { status: V; truth: string | null }
  const levelTruth = near ? `${near.name} · ${near.dist_adr} ADR (${band})` : (t.location.context_matched ? 'no level within range' : 'no context row')
  const movingRef = b.level_in_play === 'VWAP' ? t.location.vwap : b.level_in_play === 'EMA 9' ? t.location.ema9 : b.level_in_play === 'EMA 20' ? t.location.ema20 : null
  if (b.level_in_play === 'drawn level' || b.level_in_play === 'RTH open') level = { status: 'unverifiable', truth: levelTruth }
  else if (b.level_in_play === 'VWAP' || b.level_in_play === 'EMA 9' || b.level_in_play === 'EMA 20') {
    const dAtr: number | null = movingRef?.dist_atr ?? null
    level = { status: dAtr == null ? 'unverifiable' : dAtr <= 0.5 ? 'confirmed' : dAtr <= 1.0 ? 'partial' : 'contradicted',
      truth: `${b.level_in_play} · ${dAtr ?? '—'} ATR away` }
  }
  else if (!t.location.context_matched) level = { status: 'unverifiable', truth: levelTruth }
  else if (b.level_in_play === 'none') level = { status: band === 'in_space' ? 'confirmed' : band == null ? 'unverifiable' : 'contradicted', truth: levelTruth }
  else if (near && near.name === b.level_in_play) level = { status: band === 'in_space' ? 'partial' : 'confirmed', truth: levelTruth }
  else level = { status: band === 'in_space' ? 'partial' : 'contradicted', truth: levelTruth }
  // partial: right level but in-space (>0.15 ADR), or wrong level but nothing was near anyway.

  // with/against — 5m alignment is the bar-side read of the same thing.
  let woa: { status: V; truth: string | null }
  if (align == null) woa = { status: 'unverifiable', truth: 'no 5m alignment' }
  else if (b.with_or_against === 'n/a') woa = { status: align === 'neutral' ? 'confirmed' : 'not_read', truth: align }
  else if (align === 'neutral') woa = { status: 'partial', truth: align }
  else woa = { status: ((b.with_or_against === 'with') === (align === 'following')) ? 'confirmed' : 'contradicted', truth: align }

  // timing — chase band. mid is neither fresh nor extended: partial.
  let timing: { status: V; truth: string | null }
  const chaseTruth = chase ? `${t.chase.run_before_entry_atr} ATR run (${chase})` : 'no chase data'
  if (b.timing === 'unclear' || chase == null) timing = { status: chase == null ? 'unverifiable' : 'not_read', truth: chaseTruth }
  else if (chase === 'mid') timing = { status: 'partial', truth: chaseTruth }
  else timing = { status: ((b.timing === 'fresh') === (chase === 'early')) ? 'confirmed' : 'contradicted', truth: chaseTruth }

  const footprint = { status: 'unverifiable' as V, truth: null }
  return { direction, level_in_play: level, with_or_against: woa, timing, footprint, price_reads: checkPrices(b.price_reads, r) }
}

// ── price reads: look each one up ─────────────────────────────────────────
//  The image may propose a price only as something the record can check.
//  - position_line / stop_order / target_order → the recorded fill / stop / TP1
//    (contract space, tick tolerance).
//  - level_label → the harness's known session-level prices (bar space).
//  - bar_extreme → the 1-minute bar at that PT minute: inside [low, high]?
//  - drawn_level → no anchor; range-checked against the visible strip, then
//    described by distance-from-entry and touch count. "unverifiable" unless
//    it's outside the strip's range, which is "contradicted".
//  Bar space vs contract space: bars are the continuous series, the trade is a
//  contract; the harness records the basis at the entry bar. Contract-space
//  reads are shifted by that basis before any comparison to bars.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkPrices(reads: PriceRead[], r: any): PriceCheck[] {
  const t = r.truth
  const atr: number | null = t.atr_1m
  const basis: number = t.bar_basis?.basis_pts ?? 0          // contract − bar
  type Strip = Array<[string, number, number, number, number, number]>
  const strip: Strip = t.bars.strip ?? []
  const post: Strip = t.bars.post_exit ?? []
  const allBars = [...strip, ...post]
  const tol = 0.5                                              // two ticks on both ES and NQ
  const known: Array<{ name: string; price: number }> = (t.location.all ?? []).map((l: { name: string; price: number }) => ({ name: l.name, price: l.price }))
  const stripLo = strip.length ? Math.min(...strip.map(b => b[3])) : null
  const stripHi = strip.length ? Math.max(...strip.map(b => b[2])) : null
  const distAtr = (contractPrice: number): number | null =>
    atr && t.entry_price != null ? Number((Math.abs(contractPrice - t.entry_price) / atr).toFixed(2)) : null
  const touchesAt = (barPrice: number): number => {
    if (!atr) return 0
    const band = 0.15 * atr; let n = 0, inside = false
    for (const b of strip) { const near = b[2] >= barPrice - band && b[3] <= barPrice + band; if (near && !inside) { n++; inside = true } else if (!near) inside = false }
    return n
  }
  const out: PriceCheck[] = []
  for (const p of reads ?? []) {
    if (!Number.isFinite(p.price)) continue
    const base = { ...p, dist_atr_from_entry: null as number | null, touches: null as number | null }
    if (p.kind === 'position_line') {
      const ok = t.entry_price != null && Math.abs(p.price - t.entry_price) <= tol
      out.push({ ...base, status: ok ? 'confirmed' : 'contradicted', against: `recorded entry ${t.entry_price}` })
    } else if (p.kind === 'stop_order' || p.kind === 'target_order') {
      const rec = p.kind === 'stop_order' ? t.stop_price : t.tp1_price
      const what = p.kind === 'stop_order' ? 'stop' : 'TP1'
      if (rec == null) out.push({ ...base, status: 'unverifiable', against: `no recorded ${what}`, dist_atr_from_entry: distAtr(p.price) })
      else out.push({ ...base, status: Math.abs(p.price - rec) <= tol ? 'confirmed' : 'contradicted', against: `recorded ${what} ${rec}`, dist_atr_from_entry: distAtr(p.price) })
    } else if (p.kind === 'level_label') {
      const barPx = p.price - basis
      const band = Math.max(tol, (atr ?? 1) * 0.1)
      const hit = known.find(k => Math.abs(k.price - barPx) <= band)
      out.push({ ...base, status: hit ? 'confirmed' : 'contradicted', against: hit ? `${hit.name} ${hit.price} (bar space)` : `no known level within ${band.toFixed(2)} of ${barPx.toFixed(2)} (bar space)`, dist_atr_from_entry: distAtr(p.price) })
    } else if (p.kind === 'bar_extreme') {
      const bar = p.time ? allBars.find(b => b[0] === p.time) : undefined
      if (!bar) out.push({ ...base, status: 'unverifiable', against: p.time ? `no bar at ${p.time} in the strip` : 'no time given' })
      else {
        const barPx = p.price - basis
        const inside = barPx >= bar[3] - tol && barPx <= bar[2] + tol
        out.push({ ...base, status: inside ? 'confirmed' : 'contradicted', against: `bar ${bar[0]} range ${(bar[3] + basis).toFixed(2)}–${(bar[2] + basis).toFixed(2)}`, dist_atr_from_entry: distAtr(p.price) })
      }
    } else if (p.kind === 'drawn_level') {
      const barPx = p.price - basis
      const inRange = stripLo != null && stripHi != null && barPx >= stripLo - (atr ?? 0) && barPx <= stripHi + (atr ?? 0)
      out.push({ ...base, status: inRange ? 'unverifiable' : 'contradicted',
        against: inRange ? 'trader-drawn; no bar anchor (range-plausible)' : `outside the visible strip range ${((stripLo ?? 0) + basis).toFixed(2)}–${((stripHi ?? 0) + basis).toFixed(2)}`,
        dist_atr_from_entry: distAtr(p.price), touches: inRange ? touchesAt(barPx) : null })
    }
  }
  return out
}

// ── PASS 3: write-up ──────────────────────────────────────────────────────
const WRITE_SYSTEM = `You are a trading coach looking at one of this trader's trades. You have already read the chart blind (BLIND READ), every element of that read has been checked against the 1-minute bar record (VERIFICATION), and you have the tape's own account of the trade (TRUTH) — including CONTEXT: where the entry sat in the prior day's and the session's volume profile, what the 5-minute swing structure had already done, the SESSION MOMENTUM (CONTEXT.session_momentum — the last reference-level rejection and the last completed 5-minute swing before entry, the direction they point, and whether this trade was WITH that or OFFSIDES against it), whether volatility was quiet or active, whether the IB was chop, and how many times this trader had already tried the same idea at this price.

Your job is a JUDGMENT — was this a good trade or not — and the reasons, said the way an experienced trader would say it to a colleague. Not a description of the trade. Not a check of what the trader thought. A verdict on the trade as the tape shows it.

What "good" means here: the trade was placed where the context gave it a reason to work — at an edge of value or a real level rather than in the middle of a node; with the swing structure or against it at a genuine reversal spot; with the session's momentum rather than offsides — if the market rejected a reference level and travelled away, then made a swing that agreed, a trade back into that rejection is offsides unless it is the first touch of a real level (session_momentum.mitigation names it when so); when there was range to be had, not when ATR had already gone quiet and the IB was chop; as a first or second look, not the fifth attempt at the same idea. A trade that made money can still be a bad trade; a stopped-out trade can be a good one. Judge the placement, not the P&L. Say "not a good trade" when it wasn't. Say "good trade" when it was. Say "mixed" only when the context genuinely cuts both ways, and say which way.

THE LENS. The trader has chosen a coaching influence — Xyzeee (auction-market volume-profile scalper; source: his playbook + the 2026 NinjaTrader session the trader supplied) — and asked that his perspective weigh in every verdict. Apply his concepts ONLY through the fields already in TRUTH and CONTEXT; his lens changes how you weigh and phrase, never what facts exist. The concepts:
- The market is an auction. A volume node is inventory placed by both sides; the direction price BREAKS from it tells you who won it. When price leaves a node or rejects a level and cannot trade back through, the side left inside is OFFSIDES — the losing team. When CONTEXT.session_momentum.trade_is is "offsides", the trader bet on the team that just lost: "why bet on the team that's lost ten times today?" Say it that way.
- Direction first, location second, entry last. Know where the market wants to go — more importantly where it does NOT want to go — find the counterparty who isn't getting what they want, and trade against them. An entry with no failed counterparty attempt behind it is a guess, wherever it sits.
- Home court: an edge of value, a fresh rejection, the first touch of a real level. The middle of an HVN inside value is a knife fight — entering there is wedging in before the answer instead of letting both sides show their hand. This is the heaviest mark and stays the heaviest mark — with his own exception, from his execution recaps: he has filled longs "around the middle of the session’s range — something you’re probably told to never do" when the information had just shifted (a counterparty attempt that failed and momentum flipping) AND the invalidation was tight and structural. A mid-value entry earns that reading only when session_momentum shows the shift and the stop is close and placed at it — and when BOTH hold, drop the location knock entirely or say it in passing; do not make location the trade's main flaw while crediting the shift and the stop. Mid-value with a wide stop and no shift is still the knife fight.
- The chase band is the ticket price. His rule: "if you're chasing, you're overpaying for the ticket" — and "never show up to the party before the host" cuts the other way: an entry with no confirmation yet isn't early genius, it's arriving before the host. Judge timing off run_before_entry and what the momentum read says had already confirmed. TRUTH.location.ema9/ema20 are the 5-MINUTE 9/20 EMAs (always say "5m 9 EMA", never a bare or 1m EMA): he reads a market stretched far from the 5m 9 EMA as due to gravitate back to it — an entry chasing in the trend direction well away from the nine is the same overpaid ticket. Cite the EMA distance ONLY when it points the same way as the chase (long stretched ABOVE the nine, short stretched below); a long below the nine is not chasing by that measure, so leave the EMA out of it.
- Failed effort does not improve with repetition: a third-or-later attempt at the same idea is trading against the market's own answer (attempts_before). The mirror also holds — the COUNTERPARTY'S repeated failure (a rejection that travelled, structure agreeing) is exactly what makes a with-momentum entry legitimate.
- First touch of a real level rarely cuts through on the first go — a first-touch fade has a reason even against momentum (session_momentum.mitigation names it). Credit it, then name the risk.
- Invalidation is structural, never an arbitrary tick count. His stop lives where the idea dies — "if price starts to re-auction and gain acceptance back into that range, I want to cut it off" — and a stop inside the noise of the very range the entry traded from was never an invalidation. Judge risk_pts against the level and momentum facts: a stop at the structure that had to hold reads as a ticket priced right even when it was hit; a stop that was just N points away reads as a guess.
- Balance vs trend: IB chop + inside-value profile = balance — edges are for fading, middles are for nothing, and breakout-seeking earns no credit. A one-way session = get in line, don't fade it — pullbacks are for joining. EMAs mean nothing mid-range in balance; they only earn a mention when the 5m structure is one-way and price returned to them.
- VWAP, lightly: a long entered above VWAP paid up; mention only when the data shows it and it isn’t the main story. His own uses, when the data shows them: the first touch of VWAP early in the session is a spot he takes seriously (often the other way), and a move that has reached VWAP has hit its checkpoint — an exit read can lean on that.
- The exit is judged by the same auction logic as the entry. A TP parked tick-tight at a reference (exit.tp1_vs_reference.band "parked_at"), especially a weekly value edge, is asking the auction for exactness — tp1_missed_by_pts of a point or two with post-exit travel left is a placement finding, not bad luck. The payout of a with-momentum trade is the runway to the next reference (ON high/low, PDH/PDL) — name it when the trade was cut far short of it. And an exit at the second successful defense of the entry — price held, momentum intact, then flat — gave up the trade at exactly the moment the market re-proved it.
- Never narrate what the bars cannot show: no absorption, exhaustion, delta or trapped-orders stories invented for color. His voice, our evidence — the market is not out to get anyone, there are no boogeymen, and the chart is never a liar.

Rules:
1. Elements the bars CONTRADICTED are wrong. State the tape's version; do not hedge, do not narrate the correction, and never attribute your own blind read to the trader ("the label you saw", "what you thought was IBH +100%") — the trader never saw your read. Elements marked partial or unverifiable may be mentioned only as what the chart showed.
2. Every number you write must be copied from TRUTH, or be a price read in VERIFICATION.price_reads whose status is "confirmed" (or a drawn_level marked unverifiable — call it the trader's own line and use its dist_atr_from_entry / touches). Give units (ATR, ADR, pts, %, R). A contradicted price read is a misread — never mention it. Nothing else off the image.
3. Talk about the TRADE, not the trader's mind. "You bought into the middle of the prior day's value area with ATR at 0.6x its typical and the IB in chop, on the third long attempt in 40 minutes — that's not a good trade" is right. "You were frustrated" or "you got greedy" is not — you can't see that. Reasons are context facts, each with its number.
4. Lead with the verdict. Then two or three sentences of reasons, in order of weight — the thing that most decides the verdict first. Weight order: middle of a node / no real level, offsides against confirmed momentum, and a third-or-later attempt weigh most; against the swing structure and IB chop next; ATR regime and session phase after that. When session_momentum.trade_is is "offsides", say it in the trader's terms — name the level that rejected, which way price went, and that the trade went back into it ("we rejected PWH, sold off 5 ATR, and you bought the retrace") — and if mitigation is set, say the fade had a reason and name the risk instead of calling it offsides outright. Outcome is not a reason: capture %, R multiple and P&L never make a trade good or bad here — a 3R winner into the middle of a node in chop is still not a good trade, and a stopped-out first touch of a real level with structure is still a good one. Mention the outcome only under rule 6. Plain, direct, second person, no headers, no bullet points, no hedging language ("somewhat", "arguably", "it could be said"). The register is Xyzeee's: blunt and vivid — "you bought the retrace of a rejection; that's the losing team", "you overpaid for the ticket" — one sharp line per read at most, never mockery, and outcome still never a reason. If the context is genuinely thin (no profile, no structure read, no attempts), say the verdict rests on less and name what's missing.
5. dropped is a terse list — "level_in_play: IBH +100%", "stop_order 30207 (recorded 30212)" — one short item per dropped element, no sentences.
6. If the exit is itself a finding (closed with 0% captured and price then ran 2 ATR your way; or a runner held past a level that had already rejected), say so with the numbers, as a separate sentence after the verdict's reasons. If it isn't, leave the outcome out entirely.
7. footprint_observation is words only — what the pane showed — never a number of any kind.`

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['good', 'not_good', 'mixed'] },
    read: { type: 'string', description: 'Verdict first, then the reasons — 3 to 5 sentences total, second person, numbers only from TRUTH or confirmed price reads.' },
    dropped: { type: 'array', items: { type: 'string' } },
    footprint_observation: { type: ['string', 'null'], description: 'What the footprint pane showed, labelled as unverified. Null if no pane or nothing notable.' },
  },
  required: ['verdict', 'read', 'dropped', 'footprint_observation'],
  additionalProperties: false,
} as const

interface WriteUp { verdict: 'good' | 'not_good' | 'mixed'; read: string; dropped: string[]; footprint_observation: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function packageTruth(r: any) {
  const t = r.truth
  return {
    direction: r.direction, symbol: r.symbol,
    entry_price: t.entry_price, exit_price: t.exit_price, stop_price: t.stop_price, tp1_price: t.tp1_price,
    atr_1m: t.atr_1m, adr: t.adr,
    location: { context_matched: t.location.context_matched, nearest: t.location.nearest, band: locBand(t.location.nearest?.dist_adr ?? null),
      vwap: t.location.vwap, ema9: t.location.ema9, ema20: t.location.ema20, touches_before_entry: t.location.touches_before_entry },
    structure: { alignment_5m: t.structure.alignment_5m },
    context: t.context ?? {},
    chase: { run_before_entry_pts: t.chase.run_before_entry_pts, run_before_entry_atr: t.chase.run_before_entry_atr, band: chaseBand(t.chase.run_before_entry_atr) },
    exit: { realized_pts: t.exit.realized_pts, r_multiple: t.exit.r_multiple, risk_pts: t.exit.risk_pts, mfe_pts: t.exit.mfe_pts, mfe_atr: t.exit.mfe_atr,
      mae_atr: t.exit.mae_atr, capture_pct: t.exit.capture_pct, tp1_vs_reference: t.exit.tp1_vs_reference,
      tp1_missed_by_pts: t.exit.tp1_missed_by_pts, post_exit_favorable_atr: t.exit.post_exit_favorable_atr,
      post_exit_against_atr: t.exit.post_exit_against_atr, scaled_out: t.exit.scaled_out, legs: t.exit.legs },
  }
}

// ── fabrication check ─────────────────────────────────────────────────────
function numbersIn(text: string): number[] {
  return Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g)).map(m => Number(m[0])).filter(Number.isFinite)
}
function flattenNumbers(v: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof v === 'number' && Number.isFinite(v)) { out.add(Math.abs(v)) }
  else if (Array.isArray(v)) v.forEach(x => flattenNumbers(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach(x => flattenNumbers(x, out))
  return out
}
// Level NAMES carry numbers ("IBL -50%", "EMA 20", "IBH +100%") — quoting a
// name is not stating a price. Those digits are allowed.
const RUBRIC_NUMBERS = new Set<number>([...flattenNumbers(BANDS), ...numbersIn(WRITE_SYSTEM).map(Math.abs), ...LEVELS.flatMap(l => numbersIn(l).map(Math.abs)), 5, 15, 100])
/** `claimText` = the trader's tags/notes as one string. Numbers that appear
 *  there ("9 EMA", "20 EMA", "MGI 3") are legitimate to quote back in
 *  tags_vs_read; the first run flagged them as fabrications. */
function overclaims(w: WriteUp, truthPkg: unknown, claimText: string, ver: Verification): string[] {
  const allowed = flattenNumbers(truthPkg)
  for (const p of ver.price_reads) if (p.status !== 'contradicted') { allowed.add(Math.abs(p.price)); if (p.dist_atr_from_entry != null) allowed.add(p.dist_atr_from_entry); if (p.touches != null) allowed.add(p.touches) }
  // Numbers the verification step itself stated (e.g. "EMA 20 · 0.77 ATR away")
  // are bar-derived and the write-up may quote them.
  for (const [k, v] of Object.entries(ver)) if (k !== 'price_reads' && (v as { truth: string | null }).truth) for (const n of numbersIn((v as { truth: string }).truth)) allowed.add(Math.abs(n))
  // Rounding a truth value (92.3% → 92%, 1.76 → 1.8) is not fabrication.
  const matches = (a: number) => Array.from(allowed).some(x => Math.abs(x - a) < 0.011 || Math.round(x) === a || Math.round(x * 10) / 10 === a)
  const claimNums = new Set(numbersIn(claimText).map(Math.abs))
  const bad: string[] = []
  const check = (label: string, text: string | null) => {
    if (!text) return
    for (const n of numbersIn(text)) {
      const a = Math.abs(n)
      if (Number.isInteger(a) && a <= 3) continue
      if (RUBRIC_NUMBERS.has(a) || claimNums.has(a)) continue
      if (!matches(a)) bad.push(`${label}: ${n}`)
    }
  }
  check('read', w.read)
  if (w.footprint_observation && numbersIn(w.footprint_observation).length) bad.push(`footprint: contains numbers (${numbersIn(w.footprint_observation).join(', ')})`)
  return bad
}

// ── model plumbing ────────────────────────────────────────────────────────
type MediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
const mediaTypeOf = (p: string): MediaType => {
  const e = p.toLowerCase().split('.').pop() ?? ''
  return e === 'png' ? 'image/png' : e === 'gif' ? 'image/gif' : e === 'webp' ? 'image/webp' : 'image/jpeg'
}
async function fetchImage(url: string): Promise<string | null> {
  const res = await fetch(url)
  return res.ok ? Buffer.from(await res.arrayBuffer()).toString('base64') : null
}
async function jsonCall<T>(args: { system?: string; image: { b64: string; media: MediaType }; text: string; schema: Record<string, unknown>; effort: 'low' | 'medium' | 'high' }): Promise<T | { error: string }> {
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 4096, system: args.system,
    output_config: { effort: args.effort, format: { type: 'json_schema', schema: args.schema } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: args.image.media, data: args.image.b64 } },
      { type: 'text', text: args.text },
    ] }],
  })
  if (msg.stop_reason === 'refusal') return { error: 'refusal' }
  const t = msg.content.find(b => b.type === 'text')
  if (!t || t.type !== 'text') return { error: `no text (stop=${msg.stop_reason})` }
  try { return JSON.parse(t.text) as T } catch { return { error: 'unparseable json' } }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeText(r: any, blind: BlindRead, ver: Verification, truthPkg: unknown): string {
  return [
    `TRADE: ${r.direction} ${r.symbol}, entered ${r.entry_pt}, exited ${r.exit_pt ?? 'unknown'}.`,
    ``, `BLIND READ (yours, from the image alone):`, JSON.stringify(blind, null, 1),
    ``, `VERIFICATION (each element vs the bar record):`, JSON.stringify(ver, null, 1),
    ``, `TRUTH (bar-derived; the only source of numbers):`, JSON.stringify(truthPkg, null, 1),
  ].join('\n')
}

function priceLines(ok: Record<string, unknown>[]): string[] {
  const kinds = ['position_line', 'stop_order', 'target_order', 'level_label', 'bar_extreme', 'drawn_level'] as const
  const lines: string[] = ['', 'PRICE READS OFF THE IMAGE  (each looked up in the bar record / recorded fills)']
  for (const k of kinds) {
    const all = ok.flatMap(o => ((o.verification as Verification).price_reads ?? []).filter(p => p.kind === k))
    if (!all.length) continue
    const c = all.filter(p => p.status === 'confirmed').length, x = all.filter(p => p.status === 'contradicted').length, u = all.length - c - x
    lines.push(`  ${k.padEnd(14)} read ${String(all.length).padStart(3)}   confirmed ${String(c).padStart(3)}  contradicted ${String(x).padStart(3)}  unverifiable ${String(u).padStart(3)}   → ${c + x ? Math.round((c / (c + x)) * 100) + '% of checkable reads exact' : '—'}`)
  }
  return lines
}

async function main() {
  const rows = readFileSync(IN_PATH, 'utf8').trim().split('\n')
    .map(l => JSON.parse(l) as Record<string, any>).filter(r => r.frame?.signed_url)   // eslint-disable-line @typescript-eslint/no-explicit-any

  if (DRY) { console.log('── BLIND ──\n' + BLIND_PROMPT + '\n\n── WRITE SYSTEM ──\n' + WRITE_SYSTEM); return }

  const labelled = rows.filter(r => r.label?.call)
  const pool = labelled.length ? labelled : rows
  let anchored: string[] = []
  try { anchored = JSON.parse(readFileSync(ANCHORED_PATH, 'utf8')) } catch { /* none */ }
  let batch: typeof pool
  if (SPREAD) {
    // Stable across runs: if trades were already anchored, read THOSE again so
    // the trader can compare versions side by side. New records shift a plain
    // stride onto a different set (it happened — one morning's trade did it).
    const prior = pool.filter(r => anchored.includes(r.trade_id as string))
    if (prior.length >= LIMIT) batch = prior.slice(0, LIMIT)
    else {
      const step = Math.max(1, Math.floor(pool.length / LIMIT))
      const fresh = pool.filter((r, i) => i % step === 0 && !anchored.includes(r.trade_id as string))
      batch = [...prior, ...fresh].slice(0, LIMIT)
    }
    const ids = new Set([...anchored, ...batch.map(r => r.trade_id as string)])
    writeFileSync(ANCHORED_PATH, JSON.stringify(Array.from(ids), null, 1))
    anchored = Array.from(ids)
  } else batch = pool.slice(0, LIMIT)

  console.log(`model=${MODEL}  reading ${batch.length} of ${pool.length} ${labelled.length ? 'LABELLED' : 'unlabelled'} records (2 calls each)\n`)

  const out: Record<string, unknown>[] = []
  for (const [i, r] of batch.entries()) {
    const b64 = await fetchImage(r.frame.signed_url)
    if (!b64) { out.push({ trade_id: r.trade_id, error: 'image fetch' }); continue }
    const image = { b64, media: mediaTypeOf(r.frame.storage_path ?? '') }

    // Pass 1 — image only. Medium: this is the read that gets checked, and the
    // gate calibration showed descriptive fields jitter at low.
    let blind = await jsonCall<BlindRead>({ image, text: BLIND_PROMPT, schema: BLIND_SCHEMA, effort: 'medium' })
    if ('error' in blind && blind.error === 'unparseable json') blind = await jsonCall<BlindRead>({ image, text: BLIND_PROMPT, schema: BLIND_SCHEMA, effort: 'medium' })
    if ('error' in blind) { out.push({ trade_id: r.trade_id, date: r.date, error: `blind: ${blind.error}` }); console.log(`[${i + 1}] ${r.date} ERROR ${blind.error}`); continue }

    // Pass 2 — code.
    const ver = verify(blind, r)
    const truthPkg = packageTruth(r)

    // Pass 3 — write-up.
    let w = await jsonCall<WriteUp>({ system: WRITE_SYSTEM, image, text: writeText(r, blind, ver, truthPkg), schema: WRITE_SCHEMA, effort: 'medium' })
    if ('error' in w && w.error === 'unparseable json') w = await jsonCall<WriteUp>({ system: WRITE_SYSTEM, image, text: writeText(r, blind, ver, truthPkg), schema: WRITE_SCHEMA, effort: 'medium' })
    const werr = 'error' in w ? w.error : null
    const write = werr ? null : (w as WriteUp)
    const oc = write ? overclaims(write, truthPkg, JSON.stringify(r.claim), ver) : []

    // Every element the bars CONTRADICTED must appear in the write-up's own
    // `dropped` list — that is the model acknowledging the correction in a
    // field we can check, instead of a brittle text search on the prose
    // (which flagged correct sentences like "1.06 ATR below VWAP").
    const restated: string[] = []
    if (write) {
      const droppedText = write.dropped.join(' | ').toLowerCase()
      for (const [k, v] of Object.entries(ver)) {
        if (k === 'price_reads') continue
        if ((v as { status: V }).status !== 'contradicted') continue
        const key = k.toLowerCase()
        const val = String((blind as unknown as Record<string, unknown>)[k] ?? '').toLowerCase()
        if (!droppedText.includes(key) && !(val && droppedText.includes(val))) restated.push(`${k} contradicted but not in dropped`)
      }
    }

    out.push({
      trade_id: r.trade_id, date: r.date, entry_pt: r.entry_pt, symbol: r.symbol, direction: r.direction,
      label: r.label?.call ?? null, pnl: r.truth.exit.pnl,
      blind, verification: ver, write, error: werr, overclaims: oc, restated,
    })

    const vs = Object.entries(ver).filter(([k]) => k !== 'price_reads').map(([k, v]) => `${k.split('_')[0]}=${(v as { status: V }).status[0]}`).join(' ')
    const pr = ver.price_reads
    const prs = pr.length ? ` prices ${pr.filter(p => p.status === 'confirmed').length}✓/${pr.filter(p => p.status === 'contradicted').length}✗/${pr.filter(p => p.status === 'unverifiable').length}?` : ''
    console.log(`[${String(i + 1).padStart(2)}/${batch.length}] ${r.date} ${String(r.direction).padEnd(5)} ${String(r.symbol).padEnd(10)} blind: ${blind.trade_type} @${blind.level_in_play} ${blind.with_or_against}/${blind.timing}  | ${vs}${prs}${oc.length ? '  << OVERCLAIM ' + oc.join('; ') : ''}${restated.length ? '  << RESTATED' : ''}`)
    if (write) {
      console.log(`        ${write.read}`)
      if (write.dropped.length) console.log(`        dropped: ${write.dropped.join('; ')}`)
      console.log(`        VERDICT ${write.verdict.toUpperCase()}`)
    }
  }

  // ── report ─────────────────────────────────────────────────────────────
  const ok = out.filter(o => o.write)
  const elems = ['direction', 'level_in_play', 'with_or_against', 'timing'] as const
  const tallyLine = (e: typeof elems[number]) => {
    const c: Record<V, number> = { confirmed: 0, contradicted: 0, partial: 0, unverifiable: 0, not_read: 0 }
    for (const o of ok) c[(o.verification as Verification)[e].status]++
    const judged = c.confirmed + c.contradicted
    return `  ${e.padEnd(16)} confirmed ${String(c.confirmed).padStart(3)}  contradicted ${String(c.contradicted).padStart(3)}  partial ${String(c.partial).padStart(3)}  unverifiable ${String(c.unverifiable).padStart(3)}  not_read ${String(c.not_read).padStart(3)}   → ${judged ? Math.round((c.confirmed / judged) * 100) + '% of judged reads held' : '—'}`
  }
  const overclaimed = out.filter(o => (o.overclaims as string[] | undefined)?.length)
  const restatedN = out.filter(o => (o.restated as string[] | undefined)?.length)
  const lines = [
    `COACH READ — ${MODEL} — ${ok.length} read, ${out.length - ok.length} errors`,
    ``,
    `HONESTY (deterministic)`,
    `  fabricated numbers        ${overclaimed.length} / ${ok.length}   ${overclaimed.length ? '<< FAIL' : 'OK'}`,
    ...overclaimed.map(o => `     ${o.date} ${(o.overclaims as string[]).join('; ')}`),
    `  contradiction not dropped ${restatedN.length} / ${ok.length}   ${restatedN.length ? '<< FAIL' : 'OK'}`,
    ``,
    `HOW FAR EACH IMAGE READ CAN BE TRUSTED  (blind read vs bars — no labels needed)`,
    ...elems.map(tallyLine),
    `  footprint reads are reported unverified (no bar counterpart): ${ok.filter(o => (o.blind as BlindRead).footprint !== 'no_pane' && (o.blind as BlindRead).footprint !== 'nothing_notable').length} / ${ok.length} claimed a signal`,
    ...priceLines(ok),
    ``,
    `VERDICTS`,
    `  good ${ok.filter(o => (o.write as WriteUp).verdict === 'good').length}  not_good ${ok.filter(o => (o.write as WriteUp).verdict === 'not_good').length}  mixed ${ok.filter(o => (o.write as WriteUp).verdict === 'mixed').length}`,
    `  P&L-positive trades called not_good: ${ok.filter(o => (o.write as WriteUp).verdict === 'not_good' && ((o.pnl as number) ?? 0) > 0).length}  ·  losers called good: ${ok.filter(o => (o.write as WriteUp).verdict === 'good' && ((o.pnl as number) ?? 0) < 0).length}   (both should be non-zero if it judges placement, not P&L)`,
  ]
  const anchoredSet = new Set(anchored)
  const withLabel = ok.filter(o => o.label && !anchoredSet.has(o.trade_id as string))
  if (withLabel.length) {
    lines.push(``, `AGAINST YOUR VERDICTS  (n=${withLabel.length}, anchored excluded)`, `  (scoring vs good/mistake to be defined against the new read shape — the old agree/diverge framing no longer applies)`)
  } else lines.push(``, `NO LABELS — nothing scored against your verdicts.`)

  const report = lines.join('\n')
  writeFileSync(join(dirname(IN_PATH), 'reads.jsonl'), out.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  writeFileSync(join(dirname(IN_PATH), 'read-report.txt'), report + '\n', 'utf8')
  console.log('\n' + report)
}

main().catch(e => { console.error(e); process.exit(1) })
