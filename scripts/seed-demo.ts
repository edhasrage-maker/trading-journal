/**
 * Seed (or tear down) the read-only "Explore the demo" account on the PUBLIC
 * TapeScore project (tapescore.app). Creates a single auth user (DEMO_EMAIL)
 * and fills it with curated, SYNTHETIC trading data so prospects can poke at
 * every screen without signing up. All numbers are made-up — no real edge.
 *
 *   npx tsx scripts/seed-demo.ts               # dry run (prints what it would do)
 *   npx tsx scripts/seed-demo.ts --commit      # create user + seed data
 *   npx tsx scripts/seed-demo.ts --teardown --commit   # delete demo data + user
 *
 * Reads .env.public-feed (the PUBLIC project's service-role key) — NOT .env.local.
 * Hard-guards on the public project ref so it can never touch the personal DB.
 * Read-only enforcement is separate (src/middleware.ts + the demo_readonly RLS
 * migration); this script only owns the data.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { dayAchievementIds, type AchievementTrade } from '../src/lib/achievements'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const URL = process.env.PUBLIC_SUPABASE_URL || ''
const KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY || ''
const PUBLIC_REF = 'dmutgkycrjudfejswvhg'
if (!URL.includes(PUBLIC_REF)) {
  console.error(`REFUSING TO RUN: .env.public-feed does not point at the public project (${PUBLIC_REF}). URL=${URL}`)
  process.exit(1)
}

const DEMO_EMAIL = 'demo@tapescore.app'
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'tapescore-demo'
const commit = process.argv.includes('--commit')
const teardown = process.argv.includes('--teardown')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(URL, KEY, { auth: { persistSession: false } })

// ── deterministic pseudo-random so re-seeds are identical ────────────────────
let _s = 1234567
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff }
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]
const some = <T,>(a: T[], n: number): T[] => { const c = [...a]; const o: T[] = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o }

const SETUPS = ['Break & Retest', 'Trend Pullback', 'Range Reversal', 'VWAP Reclaim', 'Failed Breakout']
const CONFLUENCES = ['HTF Trend', 'VWAP', 'Prior Day High', 'Round Number', 'IB Extension']
const ORDER_FLOW = ['Absorption', 'Delta Divergence', 'Stacked Bids', 'Aggressive Sellers']
const MGMT = ['Scaled Out', 'Moved to BE', 'Held Runner', 'Full Stop']
const EMOTIONS = ['Calm', 'Patient', 'Confident', 'FOMO', 'Frustrated']
const MISTAKES = ['Chased Entry', 'Early Exit', 'Oversized']
const DAY_TYPES = ['Trend', 'Range', 'Reversal']

const TAG_LIBRARY: Array<[string, string[]]> = [
  ['setups', SETUPS], ['confluences', CONFLUENCES], ['order_flow', ORDER_FLOW],
  ['trade_management', MGMT], ['emotions', EMOTIONS], ['mistakes', MISTAKES], ['day_type', DAY_TYPES],
]

// Trading days spread across ~5 weeks so Week / Month / 30d selectors all populate.
// Each day carries a CURATED shape: per-trade win/loss outcomes, a prep bias, and
// whether it showcases a compliance Breach. Trades are re-anchored onto the REAL
// public NQ bar feed for these dates (see anchorTrade), so the LiveChart candles
// and the trade overlays line up — no synthetic bars are written (that would
// clobber the shared (symbol,ts) feed every real user reads).
type DayPlan = { outcomes: boolean[]; breach: boolean; bias: Bias }
type Bias = 'bullish' | 'bearish' | 'neutral'
// Keep the last date within a few sessions of "now" — a demo whose newest day
// is weeks old reads as abandoned. All dates need full RTH bar coverage on the
// public NQ feed (skip half-days like Juneteenth / July 3rd). The 06-22→07-01
// run is deliberately all-winners: five consecutive green SESSIONS light the
// Heat Check badge, giving the demo's achievement surfaces something to show.
const DAY_PLAN: Record<string, DayPlan> = {
  '2026-06-09': { outcomes: [true, true], breach: false, bias: 'bullish' },
  '2026-06-11': { outcomes: [true, false, true], breach: false, bias: 'bullish' },
  '2026-06-15': { outcomes: [false, false], breach: false, bias: 'bearish' },   // controlled down day, rules held
  '2026-06-17': { outcomes: [false, true, false], breach: false, bias: 'neutral' },
  '2026-06-22': { outcomes: [true], breach: false, bias: 'neutral' },           // green streak 1/5
  '2026-06-24': { outcomes: [true, true], breach: false, bias: 'bullish' },     // 2/5
  '2026-06-25': { outcomes: [true, true], breach: false, bias: 'bullish' },     // 3/5
  '2026-06-29': { outcomes: [true, true], breach: false, bias: 'bullish' },     // 4/5
  '2026-07-01': { outcomes: [true], breach: false, bias: 'bullish' },           // 5/5 → Heat Check
  '2026-07-02': { outcomes: [false, false, false], breach: true, bias: 'bearish' }, // Breach showcase (post-loss size-up)
  '2026-07-06': { outcomes: [true, false], breach: false, bias: 'neutral' },
  '2026-07-09': { outcomes: [true, true], breach: false, bias: 'bullish' },
}
const DAYS = Object.keys(DAY_PLAN)

const MNQ_MULT = 2   // MNQ = $2 / point
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Monday (YYYY-MM-DD) of the ISO week containing `date`. */
function mondayOf(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  const dow = d.getUTCDay() // 0 Sun … 6 Sat
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
  return d.toISOString().slice(0, 10)
}

interface Bar { ts: string; open: number; high: number; low: number; close: number }

/**
 * Real RTH NQ bars for a demo date, ascending. RTH is 06:30–13:00 PT; all demo
 * dates are summer (PDT = UTC-7), so that maps to 13:30–20:00 UTC. The public
 * feed stores the mini root ('NQ') — the same series the cloud LiveChart draws
 * for an 'MNQ' trade (chartSeriesRoot('MNQ') === 'NQ'). Micros trade the mini's
 * price, so anchoring MNQ trades onto NQ bars is price-correct.
 */
async function fetchRthBars(date: string): Promise<Bar[]> {
  const { data } = await sb.from('ohlcv_bars')
    .select('ts, open, high, low, close')
    .eq('symbol', 'NQ')
    .gte('ts', `${date}T13:30:00Z`)
    .lte('ts', `${date}T20:00:00Z`)
    .order('ts', { ascending: true })
  return (data || []) as Bar[]
}

async function getOrCreateUser(): Promise<string> {
  // find existing
  let page = 1
  for (;;) {
    const { data } = await sb.auth.admin.listUsers({ page, perPage: 200 })
    const hit = (data?.users || []).find((u: { email?: string }) => (u.email || '').toLowerCase() === DEMO_EMAIL)
    if (hit) return hit.id
    if (!data || data.users.length < 200) break
    page++
  }
  if (!commit) { console.log('[dry] would create user', DEMO_EMAIL); return '(dry-run-uid)' }
  const { data, error } = await sb.auth.admin.createUser({ email: DEMO_EMAIL, password: DEMO_PASSWORD, email_confirm: true })
  if (error) throw new Error('createUser: ' + error.message)
  console.log('created user', data.user.id)
  return data.user.id
}

async function wipe(uid: string) {
  // delete children first (FK), then days. trades cascade via trading_day_id in
  // some schemas, but delete explicitly to be safe.
  const { data: days } = await sb.from('trading_days').select('id').eq('user_id', uid)
  const dayIds = (days || []).map((d: { id: string }) => d.id)
  if (dayIds.length) {
    await sb.from('trades').delete().in('trading_day_id', dayIds)
    await sb.from('market_context').delete().in('trading_day_id', dayIds)
  }
  await sb.from('trading_days').delete().eq('user_id', uid)
  await sb.from('trade_tags').delete().eq('user_id', uid)
  await sb.from('weekly_recap').delete().eq('user_id', uid)
  console.log(`wiped ${dayIds.length} existing demo days`)
}

// ── one seeded trade (post-anchoring), kept for the EOD-panel text ──────────
interface SeedTrade {
  n: number; dir: 'long' | 'short'; qty: number; pnl: number; win: boolean
  setup: string; entry: number
}

/**
 * Re-anchor one trade onto the real NQ bar path so its entry/exit/excursion sit
 * ON the candles the LiveChart draws. Direction is chosen so the trade realizes
 * the CURATED outcome (win/loss) against the real move; high/low_during_position
 * are the true segment extremes, so MFE/MAE read honestly against the chart.
 */
function anchorTrade(bars: Bar[], i: number, n: number, wantWin: boolean, qty: number, sizedUp: boolean) {
  const usable = Math.max(20, bars.length - 25)
  const entryIdx = clamp(Math.floor(((i + 0.5) / n) * usable * 0.85), 2, bars.length - 20)
  const holdBars = 12 + Math.floor(rnd() * 28)
  const exitIdx = Math.min(bars.length - 1, entryIdx + holdBars)
  const entry = Math.round(bars[entryIdx].close)
  // Pick the side that makes this trade win/lose the way the real move went, so
  // the excursion (segment high/low) stays consistent with the direction.
  const realUp = bars[exitIdx].close >= entry
  const isLong = wantWin ? realUp : !realUp
  const dir: 'long' | 'short' = isLong ? 'long' : 'short'

  const seg = bars.slice(entryIdx, exitIdx + 1)
  const segHigh = Math.max(...seg.map(b => b.high))
  const segLow = Math.min(...seg.map(b => b.low))
  const favPts = Math.max(1, Math.round(isLong ? segHigh - entry : entry - segLow))
  const favMaxDollars = favPts * qty * MNQ_MULT     // full-qty MFE ceiling in $

  // Dollar-FIRST P&L, sized for a small-account trader on a -$500 daily loss
  // limit (standard risk ~$90–230; a size-up loss runs bigger). Points are
  // backed out from the dollars for chart placement. Winners are CAPPED at
  // 60–85% of the segment's real MFE ceiling — realized can never exceed the
  // peak favorable move, or capture/Conversion reads >100% (the app leaves
  // that unclamped on purpose, as a corrupt-data flag).
  const pnl = wantWin
    ? Math.max(2, Math.min(
        120 + Math.round(rnd() * 300),              // +$120..420 curated…
        Math.round(favMaxDollars * (0.6 + rnd() * 0.25)),  // …but ≤60-85% of real MFE
      ))
    : sizedUp
      ? -(300 + Math.round(rnd() * 230))            // -$300..530 (10-lot size-up loss)
      : -(90 + Math.round(rnd() * 140))             // -$90..230 (standard stop-out)
  const favPtsSigned = pnl / (qty * MNQ_MULT)       // >0 on a win
  const exit = Math.round(entry + (isLong ? favPtsSigned : -favPtsSigned))

  // Stop placement must be consistent with the trade's story or the MAE%-of-stop
  // and heat columns read as corrupt data (a "winner" whose recorded heat ran
  // 3× past its stop is impossible — the stop would have filled):
  //   winners  → the stop survived the trade's REAL adverse excursion, so it
  //              sits a few points beyond the segment's actual heat;
  //   losers   → the exit IS the stop-out, so the stop sits at the realized
  //              adverse exit (the dollars already priced it).
  const maePts = Math.max(0, Math.round(isLong ? entry - segLow : segHigh - entry))
  const stopPts = wantWin
    ? Math.max(18 + Math.round(rnd() * 22), maePts + 3 + Math.round(rnd() * 5))
    : Math.max(8, Math.abs(Math.round(favPtsSigned)))
  const tp1Pts = Math.round(stopPts * (2.0 + rnd() * 0.6))    // ~2.0–2.6R
  const stop = entry + (isLong ? -stopPts : stopPts)
  const tp1 = entry + (isLong ? tp1Pts : -tp1Pts)

  // 1-min ATR snapshot at entry (mean bar range over the prior 14 bars) — feeds
  // the ×ATR efficiency panels, Coach Score evidence, and the Sniper badge.
  const atrWin = bars.slice(Math.max(0, entryIdx - 14), entryIdx)
  const atr1m = atrWin.length
    ? Math.max(1, Math.round(atrWin.reduce((s, b) => s + (b.high - b.low), 0) / atrWin.length * 100) / 100)
    : null

  // Recorded excursion extremes. Winners keep the real segment extremes (their
  // stop is beyond them by construction). Losers clip the ADVERSE side at the
  // stop-out fill — the position no longer exists past its stop, so heat beyond
  // the exit is another impossible shape (MAE% > 100 of stop).
  const high = wantWin
    ? Math.max(Math.round(segHigh), exit)
    : isLong ? Math.round(segHigh) : exit
  const low = wantWin
    ? Math.min(Math.round(segLow), exit)
    : isLong ? exit : Math.round(segLow)

  return {
    dir, entry, exit, stop, tp1, pnl, atr1m,
    high, low,
    // Full-position peak-favorable $ (pts × qty × multiplier) — the same unit
    // captureComponents grades against. The old pts × $2 value forgot qty and
    // shrank the denominator 5-10×, which is what printed 218% Conversion.
    mfeLeg: favMaxDollars,
    entryTime: bars[entryIdx].ts, exitTime: bars[exitIdx].ts,
  }
}

/** Prep-quality AI panel (trading_days.ai_analysis_json) — matches AiAnalysis. */
function genPrepAI(date: string, dayType: string, bias: Bias, score: number) {
  const thesis = bias === 'bullish'
    ? 'holding above the overnight low and prior-day VWAP, favoring longs into an IB extension'
    : bias === 'bearish'
      ? 'rejecting the prior-day high with supply stacked overhead, favoring fades from the highs'
      : 'rotating inside the initial balance on a two-way tape with no strong directional edge'
  return {
    summary: `Solid prep for a ${dayType.toLowerCase()} day. The ${bias} bias is anchored to the overnight range and prior-day levels, with a defined area of interest, invalidation, and first target on each plan. This is Tier ${score} prep — plans are complete and the day character is read correctly before the open.`,
    chart_thesis: `Price is ${thesis}.`,
    chart_structure_notes: [
      'Key contested zone marked around IBH/IBL — the reaction there defines the session.',
      `HTF levels (PDH/PDL, ONH/ONL) tagged; the ${bias} lean is structurally grounded.`,
    ],
    flags: [
      `Watch for a failed ${bias === 'bearish' ? 'breakdown at the lows' : 'breakout at the highs'} — a reclaim would invalidate the primary plan.`,
      'Size discipline: standard 5 MNQ unless a qualifying S&D setup prints with 2/3 orderflow.',
    ],
    strengths: [
      'Clear invalidation and a defined first target on every plan.',
      'Day type and volume-profile shape identified before the open.',
    ],
    score,
    analyzed_at: `${date}T14:05:00.000Z`,
  }
}

/** EOD process + execution AI panel (trading_days.eod_ai_analysis_json). */
function genEodAI(date: string, dayType: string, ts: SeedTrade[], dayPnl: number, breach: boolean, pf: number | null) {
  const wins = ts.filter(t => t.win).length
  const losses = ts.length - wins
  const green = dayPnl >= 0
  const r2 = (v: number) => Math.round(v * 100) / 100
  const money = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(Math.round(v))}`

  // Process — P1 (daily loss limit) is DERIVED from the actual day P&L so the
  // panel can never contradict the number (-$550 hard floor incl. slippage
  // buffer). P2/P3 fail only on the curated Breach day (post-loss 10 MNQ
  // size-ups). Verdict follows pass_count (≥4 = Compliant).
  const pass = (reason: string) => ({ status: 'pass' as const, breach_count: 0, reason })
  const p1Fail = dayPnl < -550
  const P1 = p1Fail
    ? { status: 'fail' as const, breach_count: 1, reason: `Session net P&L ${money(dayPnl)} blew through the -$500 daily loss limit (past the -$550 slippage floor).` }
    : pass(`Session net P&L ${money(dayPnl)} within the -$500 daily loss limit.`)
  const per_rule = breach
    ? {
        P1,
        P2: { status: 'fail' as const, breach_count: 2, reason: `T${ts.length - 1} and T${ts.length} used 10 MNQ on Supply & Demand setups with no logged qualifying orderflow (no 2/3 signals) — non-Qualifying S&D entries.` },
        P3: { status: 'fail' as const, breach_count: 2, reason: `T${ts.length - 1} and T${ts.length} both sized up to 10 MNQ after a prior same-session loss, breaching the post-loss 5 MNQ cap.` },
        P4: pass('Every loss was followed by ≥90s pause before re-entry.'),
        P5: pass(`${ts.length} trades taken; within the 7-trade cap.`),
      }
    : {
        P1,
        P2: pass('All trades sized ≤5 MNQ; no size-up exception invoked.'),
        P3: pass('No size-up after a loss; every post-loss trade was ≤5 contracts.'),
        P4: pass('Every loss was followed by ≥90s pause before re-entry.'),
        P5: pass(`${ts.length} trades taken; within the 7-trade cap.`),
      }
  const passCount = Object.values(per_rule).filter(r => r.status === 'pass').length
  const verdict: 'Compliant' | 'Breach' = passCount >= 4 ? 'Compliant' : 'Breach'
  const breach_count_vector = { P1: p1Fail ? 1 : 0, P2: breach ? 2 : 0, P3: breach ? 2 : 0, P4: 0, P5: 0 }

  // Execution — believable sub-metrics; low on the breach day, healthier on
  // clean green days. compliant_trade_count excludes the breach trades.
  const wr = ts.length ? wins / ts.length : 0
  const j = (base: number, spread: number) => r2(clamp(base + (rnd() - 0.5) * spread, 0, 1))
  const compliantCount = breach ? Math.max(1, ts.length - 2) : ts.length
  const execParams = breach ? j(0.22, 0.08) : j(0.6 + wr * 0.18, 0.12)
  const mfe = breach ? j(0.4, 0.12) : j(0.5 + wr * 0.2, 0.16)
  const prep = breach ? j(0.25, 0.1) : j(0.62, 0.16)
  const pfScore = pf == null ? null : r2(clamp(pf / 2, 0, 1))
  const parts: Array<[number | null, number]> = [[execParams, 0.41], [mfe, 0.24], [prep, 0.24], [pfScore, 0.11]]
  let num = 0, den = 0
  for (const [v, w] of parts) { if (v == null) continue; num += v * w; den += w }
  const composite = den > 0 ? r2(num / den) : null
  const breakdown = breach
    ? { setup_in_playbook: 1, stop_in_atr_band: 0.5, tp1_at_2r_or_reasoned: 0, clear_area_of_interest: 1, two_thirds_orderflow: 0, break_of_cluster_or_bubble_entry: 0, chart_not_emotion_management: 0.5, no_mistakes_tagged: 0, stable_emotion: 0.5 }
    : { setup_in_playbook: 1, stop_in_atr_band: r2(clamp(0.8 + (rnd() - 0.5) * 0.3, 0, 1)), tp1_at_2r_or_reasoned: 1, clear_area_of_interest: 1, two_thirds_orderflow: rnd() > 0.5 ? 1 : 0.5, break_of_cluster_or_bubble_entry: rnd() > 0.4 ? 1 : 0.5, chart_not_emotion_management: 1, no_mistakes_tagged: wr >= 0.5 ? 1 : 0.5, stable_emotion: 1 }

  const bigWin = [...ts].filter(t => t.win).sort((a, b) => b.pnl - a.pnl)[0]
  const bigLoss = [...ts].filter(t => !t.win).sort((a, b) => a.pnl - b.pnl)[0]

  // One TapeScore day-verdict sentence (≤14 words, decision quality not P&L)
  // — feeds the EOD hero directly; without it legacy fallback text shows.
  const headline = breach
    ? 'Sizing up after losses turned a manageable red day destructive.'
    : green
      ? 'Disciplined, level-anchored trading — the wins were earned, not lucky.'
      : 'Controlled red day — the rules held even when the reads did not.'

  return {
    headline,
    summary: breach
      ? `Session is a Breach: P2 and P3 failed — the last two entries sized to 10 MNQ after losses with no qualifying orderflow — and the ${money(dayPnl)} net blew the daily loss limit (P1). Execution was compromised: revenge cycling the same ${dayType.toLowerCase()} thesis without a structural reset.`
      : `Clean ${dayType.toLowerCase()} day, net ${money(dayPnl)} on ${wins}W / ${losses}L. Every safety rail held; execution was ${composite && composite >= 0.6 ? 'sharp' : 'workable'} — ${bigWin ? `T${bigWin.n} (${money(bigWin.pnl)}) carried the day` : 'gains came from disciplined base setups'}.`,
    what_worked: breach
      ? [
          'The session started disciplined — the first entry was standard size at a pre-marked level with a defined stop.',
          'The rule breaks were logged honestly the same day instead of buried — that is what makes tomorrow\'s reset possible.',
        ]
      : green
        ? [
            bigWin ? `T${bigWin.n} ${bigWin.dir} on ${bigWin.setup} (${money(bigWin.pnl)}) — a clean playbook read with follow-through and no mistake tags.` : 'Stuck to standard 5 MNQ sizing and let the base setup work.',
            'Standard sizing held all session — no reaching for the size-up exception without qualifying orderflow.',
            'Areas of interest were pre-marked in prep, so entries were at levels rather than chased mid-range.',
          ]
        : [
            'Losses were controlled and stops respected — no blowing through the daily loss limit.',
            'Kept sizing at 5 MNQ despite the red tape; discipline held even when the reads didn\'t.',
          ],
    mistakes: breach
      ? [
          `T${ts.length - 1} and T${ts.length} sized to 10 MNQ on Supply & Demand with no documented 2/3 orderflow — violating the size-up gate (P2).`,
          `Both size-ups came after a realized loss, breaching the post-loss 5 MNQ cap (P3) — sizing escalated exactly when it should have shrunk.`,
          `Same ${dayType.toLowerCase()} thesis attempted repeatedly with no structural reset between attempts — revenge cycling.`,
        ]
      : bigLoss
        ? [`T${bigLoss.n} ${bigLoss.dir} (${money(bigLoss.pnl)}) — thesis invalidated; the stop did its job but the entry timing was early relative to the trigger.`]
        : ['No material execution mistakes — a rare clean sheet.'],
    patterns: [
      green ? 'Best results came from named playbook setups at pre-marked levels, not discretionary mid-range entries.' : 'Losses clustered where entries preceded a confirmed trigger — timing, not thesis, was the leak.',
      breach ? 'Sizing escalates precisely when it should shrink — the post-loss size-up is the recurring failure mode.' : 'Post-loss discipline held: sizing stayed flat and cooldowns were respected.',
    ],
    next_session_focus: breach
      ? [
          'After any loss, hard-cap at 5 MNQ for the rest of the session — no qualifying-orderflow exception applies post-loss.',
          'If the same directional thesis loses twice, the idea is dead for the day — log it and step away from that level.',
        ]
      : [
          'Keep pre-marking areas of interest in prep — the level-anchored entries are outperforming discretionary ones.',
          'Before entering, name the two of three orderflow signals present; if you can\'t, stay at standard size.',
        ],
    process: {
      verdict,
      per_rule,
      breach_count_vector,
      headline: breach ? 'Breach — post-loss 10 MNQ size-ups blew the daily loss limit.' : 'Compliant — all five safety rails held this session.',
      notes: breach
        ? 'The 10 MNQ sizing on the final two trades is the core mechanical failure — both follow losses, neither has documented Qualifying S&D, and the resulting drawdown pushed the session past the daily loss limit.'
        : 'All five safety rails pass — a clean rule sheet; the size of the day does not change the verdict.',
    },
    execution: {
      execution_parameters: execParams,
      mfe_capture: mfe,
      prep_adherence: prep,
      profit_factor: pf,
      planned_vs_realized_rr: null,
      composite,
      compliant_trade_count: compliantCount,
      execution_parameter_breakdown: breakdown,
      headline: breach
        ? 'Absent orderflow and non-structural entries dragged execution on the compliant trades too.'
        : composite && composite >= 0.6
          ? 'Clean entry quality and level-anchored setups; capture was solid.'
          : 'Sound process but capture left some of the move on the table.',
      notes: breach
        ? 'Only the early trades pass all per-trade rules; the 10-lot entries are excluded. Even on the compliant trades, orderflow was absent and entries weren\'t break-of-cluster, dragging execution parameters down.'
        : 'Entries were setup-in-playbook at clear areas of interest with sensible stops. The main variance is MFE capture — a little more patience on runners would lift the composite.',
    },
    // Stamped at seed-run time, NOT the trading date: the EOD card flags the
    // analysis "Stale — re-run" whenever a trade's updated_at (= the reseed
    // moment) is newer than analyzed_at, and the demo can't re-run Analyze.
    analyzed_at: new Date().toISOString(),
  }
}

/** Weekly coach synthesis (weekly_recap.ai_synthesis_json). */
function genWeekly(weekStart: string, days: Array<{ date: string; pnl: number; dayType: string; breach: boolean }>) {
  const pnl = days.reduce((s, d) => s + d.pnl, 0)
  const greens = days.filter(d => d.pnl >= 0).length
  const breaches = days.filter(d => d.breach).length
  const grade: 'A' | 'B' | 'C' | 'D' | 'F' = breaches > 0 ? 'C' : pnl > 800 ? 'A' : pnl >= 0 ? 'B' : 'D'
  const green = pnl >= 0
  const money = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(Math.round(v))}`
  return {
    prior_week_overview: '',   // first modeled week; keeps the "vs last week" panel graceful
    week_comparison: [] as string[],
    headline: green
      ? 'Process held all week — level-anchored setups did the heavy lifting.'
      : 'Red week, but discipline mostly held — the leaks were timing, not rules.',
    themes: [
      `Net ${money(pnl)} across ${days.length} trading days (${greens} green); the edge came from named playbook setups at pre-marked levels.`,
      breaches > 0
        ? `One rule Breach this week — a post-loss 10 MNQ size-up with no qualifying orderflow; the post-loss sizing rule is the week's sharpest leak.`
        : 'No rule breaks — sizing stayed at 5 MNQ and post-loss cooldowns were respected every session.',
      'MFE capture is the main variance: winners are being closed a touch early relative to their peak favorable excursion.',
    ],
    what_worked: [
      'Discretionary mid-range entries were largely avoided in favor of PDH/PDL and IB-extension levels marked in prep.',
      'Standard 5 MNQ sizing held on all but the flagged trades — no reaching for the size-up without 2/3 orderflow.',
    ],
    what_didnt: breaches > 0
      ? [
          'The Breach day: sizing escalated to 10 MNQ after losses instead of shrinking — the single biggest cost of the week.',
          'A handful of entries preceded a confirmed trigger, turning good theses into avoidable stop-outs.',
        ]
      : [
          'A handful of entries preceded a confirmed trigger, turning good theses into avoidable stop-outs.',
          'Winners were occasionally cut early, leaving favorable excursion on the table.',
        ],
    focus_next_week: [
      'Hard-cap at 5 MNQ after any loss — the size-up exception never applies post-loss.',
      'Name two of three orderflow signals before entering; if you can\'t, stay standard size and wait for the trigger.',
    ],
    weekly_grade: grade,
    grade_reasoning: breaches > 0
      ? 'Execution was fundamentally sound but a post-loss size-up breach caps the grade — the process broke where it matters most.'
      : green
        ? 'The way the week was traded was disciplined and repeatable regardless of the result — sizing, levels, and cooldowns all held.'
        : 'A losing week traded with mostly-sound process; the grade reflects outcome drag, not a discipline failure.',
    generated_at: `${weekEndIso(weekStart)}T22:00:00.000Z`,
    model: 'claude-sonnet-4-6',
  }
}

/**
 * Per-trade journal note. Doubles as the EOD "AI Overview" fallback row (the
 * demo can't call the summary route), so vary the voice — identical one-liners
 * on every row read as canned.
 */
function tradeNote(win: boolean, sizedUp: boolean, setup: string): string {
  if (sizedUp) return pick([
    "Sized up chasing it back — couldn't give up on the idea.",
    'Doubled size to make it back fast. Knew the rule and broke it anyway.',
  ])
  const s = setup.toLowerCase()
  return win
    ? pick([
        `${setup} at the pre-marked level — entered on the retest, scaled at TP1 and let the rest work.`,
        `Waited for the ${s} trigger to actually print. Clean fill, barely any heat into target.`,
        `Second test of the zone held, so I took the ${s} with structure behind it. Paid quickly.`,
        `Patient with this one — level from prep, ${s} confirmed, managed off the chart not the P&L.`,
      ])
    : pick([
        `${setup} looked right but the level gave way — stopped at plan, no chase.`,
        `Early on the ${s}; the trigger hadn't fully printed. Stop did its job.`,
        `Thesis died when the reclaim failed. Took the stop and left the level alone.`,
        `Good location, wrong read — momentum never confirmed. Small loss, moved on.`,
      ])
}

/** Friday-ish ISO date for the week's generated_at stamp. */
function weekEndIso(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 4)
  return d.toISOString().slice(0, 10)
}

async function seed(uid: string) {
  // Tag library (best-effort — feeds the Settings → Tags list).
  const tagRows = TAG_LIBRARY.flatMap(([category, labels]) =>
    labels.map((label, i) => ({ category, label, sort_order: i, user_id: uid })))
  const { error: te } = await sb.from('trade_tags').insert(tagRows)
  if (te) console.warn('  trade_tags insert skipped:', te.message)

  let totalTrades = 0
  // Accumulate per-week facts so we can seed one weekly_recap per week after.
  const weekAgg: Record<string, Array<{ date: string; pnl: number; dayType: string; breach: boolean }>> = {}
  // Per-day inputs for the achievements pass (persisted after all days exist,
  // since Career Day / Heat Check need the full P&L history).
  const achDays: Array<{ date: string; dayId: string; pnl: number; trades: AchievementTrade[]; dayRangePts: number | null }> = []

  for (const date of DAYS) {
    const plan = DAY_PLAN[date]
    const dayType = pick(DAY_TYPES)

    const bars = await fetchRthBars(date)
    if (bars.length < 30) {
      console.warn(`  ${date}: only ${bars.length} NQ bars — chart may be sparse (feed gap?)`)
    }

    const { data: day, error: de } = await sb.from('trading_days')
      .insert({ user_id: uid, date, day_type: dayType, day_types: [dayType] })
      .select('id').single()
    if (de) throw new Error(`day ${date}: ${de.message}`)
    const dayId = day.id

    const n = plan.outcomes.length
    let dayPnl = 0
    let winSum = 0, lossSum = 0
    const seedTrades: SeedTrade[] = []
    const achTrades: AchievementTrade[] = []

    for (let i = 0; i < n; i++) {
      const wantWin = plan.outcomes[i]
      // Breach day: last two trades size up to 10 MNQ (the P2/P3 story). Else 2..5.
      const sizedUp = plan.breach && i >= n - 2
      const qty = sizedUp ? 10 : 2 + Math.floor(rnd() * 4)

      const a = bars.length >= 30
        ? anchorTrade(bars, i, n, wantWin, qty, sizedUp)
        : (() => {
            // Fallback (feed gap): synthetic near a plausible NQ level.
            const base = 29500, entry = base + Math.round((rnd() - 0.5) * 60)
            const isLong = wantWin
            const mv = wantWin ? 40 : -30
            // Favorable extreme: long win runs 45 pts up, short loss only saw 25
            // pts favorable before reversing. mfeLeg = pts × qty × mult (full
            // position $), matching what captureComponents grades against.
            return { dir: (isLong ? 'long' : 'short') as 'long' | 'short', entry, exit: entry + (isLong ? mv : -mv), stop: entry + (isLong ? -30 : 30), tp1: entry + (isLong ? 70 : -70), pnl: mv * qty * MNQ_MULT, atr1m: 9, high: entry + 45, low: entry - 25, mfeLeg: (isLong ? 45 : 25) * qty * MNQ_MULT, entryTime: `${date}T${String(14 + i).padStart(2, '0')}:10:00Z`, exitTime: `${date}T${String(14 + i).padStart(2, '0')}:40:00Z` }
          })()

      dayPnl += a.pnl
      if (a.pnl >= 0) winSum += a.pnl; else lossSum += -a.pnl

      const setups = some(SETUPS, 1 + Math.floor(rnd() * 2))
      const tags = {
        setups,
        confluences: some(CONFLUENCES, 1 + Math.floor(rnd() * 2)),
        order_flow: sizedUp ? [] : some(ORDER_FLOW, Math.floor(rnd() * 2)),
        trade_management: some(MGMT, 1),
        day_type: dayType,
        mistakes: wantWin ? [] : some(MISTAKES, sizedUp ? 1 : (rnd() > 0.6 ? 1 : 0)),
        emotions: sizedUp ? ['Frustrated'] : some(EMOTIONS, 1),
      }

      const { error: tre } = await sb.from('trades').insert({
        trading_day_id: dayId, user_id: uid, symbol: 'MNQ', direction: a.dir, quantity: qty,
        entry_price: a.entry, exit_price: a.exit, stop_price: a.stop, tp1_price: a.tp1, pnl: a.pnl,
        entry_time: a.entryTime, exit_time: a.exitTime,
        high_during_position: a.high, low_during_position: a.low,
        mfe_dollars_per_leg: a.mfeLeg,
        entry_atr_1m: a.atr1m,
        tags_json: tags,
        notes: tradeNote(wantWin, sizedUp, setups[0] ?? 'Trend Pullback'),
      })
      if (tre) throw new Error(`trade ${date}#${i}: ${tre.message}`)
      seedTrades.push({ n: i + 1, dir: a.dir, qty, pnl: a.pnl, win: wantWin, setup: setups[0] ?? 'Trend Pullback', entry: a.entry })
      achTrades.push({
        id: `${date}#${i + 1}`, trading_day_id: dayId, symbol: 'MNQ', direction: a.dir,
        quantity: qty, entry_price: a.entry, exit_price: a.exit, stop_price: a.stop,
        pnl: a.pnl, entry_time: a.entryTime, tags_json: tags,
        high_during_position: a.high, low_during_position: a.low, entry_atr_1m: a.atr1m,
      } as unknown as AchievementTrade)
      totalTrades++
    }

    const pf = lossSum > 0 ? Math.round((winSum / lossSum) * 100) / 100 : (winSum > 0 ? 10 : null)

    // Pre-baked AI panels (no Anthropic call — demo AI routes are 403-blocked).
    const prepScore = plan.breach ? 6 : (dayPnl >= 0 ? 7 : 6)
    const prepAI = genPrepAI(date, dayType, plan.bias, prepScore)
    const eodAI = genEodAI(date, dayType, seedTrades, dayPnl, plan.breach, pf)

    await sb.from('trading_days').update({
      eod_pnl: dayPnl,
      ai_analysis_json: prepAI,
      eod_ai_analysis_json: eodAI,
      eod_notes: dayPnl >= 0
        ? `Solid ${dayType.toLowerCase()} day — followed the plan, took what the tape gave.`
        : plan.breach
          ? `${dayType} day that got away — sized up chasing it back after losses. Rule break logged; reset tomorrow.`
          : `${dayType} day that didn't cooperate. Losses were controlled; no rule breaks.`,
    }).eq('id', dayId)

    // Market context anchored to the day's real price range.
    const dHigh = bars.length ? Math.max(...bars.map(b => b.high)) : (seedTrades[0]?.entry ?? 29500) + 120
    const dLow = bars.length ? Math.min(...bars.map(b => b.low)) : (seedTrades[0]?.entry ?? 29500) - 120
    const { error: mce } = await sb.from('market_context').insert({
      trading_day_id: dayId, user_id: uid, symbol: 'MNQ',
      pdh: Math.round(dHigh + 25), pdl: Math.round(dLow - 25),
      ibh: Math.round(dHigh - 15), ibl: Math.round(dLow + 15),
      onh: Math.round(dHigh + 55), onl: Math.round(dLow - 55),
      rvol: Math.round((0.8 + rnd() * 0.7) * 100) / 100,
      ib_size: 90 + Math.round(rnd() * 70),
      adr: 230 + Math.round(rnd() * 60),
      day_range: Math.round(dHigh - dLow),
      atr_1m: Math.round((6 + rnd() * 5) * 10) / 10,
    })
    if (mce) console.warn(`  market_context ${date} skipped:`, mce.message)

    achDays.push({ date, dayId, pnl: dayPnl, trades: achTrades, dayRangePts: Math.round(dHigh - dLow) })

    const wk = mondayOf(date)
    ;(weekAgg[wk] ??= []).push({ date, pnl: dayPnl, dayType, breach: plan.breach })
  }

  // Achievements pass — run the SAME pure engine the app uses over the seeded
  // days and persist the earned ids, so the dashboard markers, collection strip
  // and EOD ×N counts light up. (The demo can't run the backfill route: it's
  // POST-blocked and owner-gated.) Full history is passed to every day, matching
  // recomputeAndPersistDay's semantics for Career Day / Heat Check.
  const pnlHistory = achDays.map(d => ({ date: d.date, pnl: d.pnl }))
  let earnedTotal = 0
  for (const d of achDays) {
    const ids = dayAchievementIds({ date: d.date, dayPnl: d.pnl, trades: d.trades, pnlHistory, dayRangePts: d.dayRangePts })
    if (ids.length) { earnedTotal += ids.length; console.log(`  ${d.date} achievements: ${ids.join(', ')}`) }
    const { error: ae } = await sb.from('trading_days').update({ achievements_json: ids }).eq('id', d.dayId)
    if (ae) { console.warn('  achievements skipped:', ae.message); break }
  }
  console.log(`  achievements earned across the seed: ${earnedTotal}`)

  // Weekly recaps — one per week that has demo days.
  let weeks = 0
  for (const [weekStart, wdays] of Object.entries(weekAgg)) {
    const synthesis = genWeekly(weekStart, wdays)
    const { error: we } = await sb.from('weekly_recap').upsert(
      { user_id: uid, week_start_date: weekStart, ai_synthesis_json: synthesis, notes_md: '', generated_at: synthesis.generated_at, updated_at: synthesis.generated_at },
      { onConflict: 'user_id,week_start_date' },
    )
    if (we) console.warn(`  weekly_recap ${weekStart} skipped:`, we.message)
    else weeks++
  }

  console.log(`seeded ${DAYS.length} days, ${totalTrades} trades, ${weeks} weekly recaps (AI panels pre-baked)`)
}

async function main() {
  console.log(`\n=== seed-demo (${commit ? 'COMMIT' : 'DRY RUN'}${teardown ? ', TEARDOWN' : ''}) → ${PUBLIC_REF} ===`)
  const uid = await getOrCreateUser()

  if (teardown) {
    if (!commit) { console.log('[dry] would wipe demo data + delete user'); return }
    await wipe(uid)
    await sb.auth.admin.deleteUser(uid)
    console.log('demo user deleted')
    return
  }

  if (!commit) {
    console.log(`[dry] would seed ${DAYS.length} days of synthetic trades for ${DEMO_EMAIL}`)
    console.log('[dry] re-run with --commit to write')
    return
  }
  await wipe(uid) // idempotent re-seed
  await seed(uid)
  console.log('\nDONE. Demo user ready:', DEMO_EMAIL)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
