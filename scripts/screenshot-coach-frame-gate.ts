/**
 * Frame-gate calibration — step 2 of the screenshot coach.
 *
 *   npx tsx scripts/screenshot-coach-frame-gate.ts                 # ~30 images
 *   npx tsx scripts/screenshot-coach-frame-gate.ts --limit=14      # control only
 *   npx tsx scripts/screenshot-coach-frame-gate.ts --in=<jsonl>
 *
 * `--limit` is the TOTAL; the positive control (every provably-pre-exit
 * trade, 14 in the owner's set) is always included in full because it is the
 * only scoreable part, and unknowns fill the remainder. `--limit` below the
 * control size therefore runs the control alone.
 *
 * Calibration log — each pass, what changed and why:
 *   v1: 4/14 false alarms on the control. Every one cited a P&L readout as
 *       proof of a finished trade. Sierra paints the OPEN, unrealised P&L on
 *       the live position line, so a dollar figure is what an open trade looks
 *       like. Definitional bug in the prompt, not a vision failure.
 *   v2: prompt now says a P&L number is NOT evidence of completion; needs an
 *       entry AND a separate exit marker, or a flat/closed tag.
 *       Result: 0/14 false alarms, held across two runs. On 16 unknowns
 *       (8 OBS / 8 manual): 15 "no", 1 "unknown", zero "yes".
 *
 * Two limits of what this proves, stated so nobody over-reads it:
 *   - NO NEGATIVE CONTROL. Zero false alarms shows the gate does not INVENT a
 *     finished trade; it cannot show the gate would CATCH one, because no
 *     screenshot in the set is provably post-exit. v1→v2 fixed over-claiming;
 *     whether v2 now under-claims is unmeasured until a known-completed shot
 *     exists to test against.
 *   - JITTER at effort=low. Between the two v2 runs the entry-marker field
 *     flipped on 2/14 controls and chart_right_of_entry on 3/14. Nothing
 *     crossed into "completed=yes", so the safety property is stable; the
 *     descriptive fields are not. Production: higher effort or two votes.
 *
 * The gate decides whether a screenshot may be read at all: an image that
 * already shows how the trade ended cannot be evidence of what the trader
 * could see at the decision. `screenshot-coach-harness.ts` established that
 * METADATA CANNOT ANSWER THIS — storage upload times and the epoch in the
 * filename are both WRITE times and arrive in batches, so they bound the
 * capture from one side only. That leaves a vision call, and a vision call
 * has to be measured before it is trusted (the Pt 18 lesson: confidence tiers
 * are measured, not guessed).
 *
 * THE CONTROL. Metadata proves one thing: a file WRITTEN before the exit
 * cannot contain post-exit bars. Those trades are a positive control the
 * model must not fail — if it reports a completed trade on an image that
 * provably predates the exit, it is inventing, and its reads on the ~137
 * unknowns are worth nothing. This is a false-alarm test; it cannot measure
 * misses, because no trade is provably post-exit.
 *
 * The same pass collects footprint-pane reads UNSCORED. Axis 3 ships as
 * chase/timing off the bars; confirmation stays out of the rubric until
 * there is evidence these reads are reliable enough to promote.
 *
 * Model: claude-sonnet-5 — the first Sonnet-tier model with high-resolution
 * vision (2576px long edge, vs 1568px on Sonnet 4.6). A 2-pane Sierra capture
 * is exactly the dense-chart case that resolution buys.
 *
 * Costs model calls. ~30 images is a few hundred input tokens' worth of
 * dollars, not a backfill — keep it that way.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import Anthropic from '@anthropic-ai/sdk'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null

const IN_PATH = argVal('in') ?? join(process.cwd(), 'evals', 'screenshot-coach', 'unlabelled-trades.jsonl')
const LIMIT = Number(argVal('limit') ?? '30') || 30
const MODEL = argVal('model') ?? 'claude-sonnet-5'

// The signed URLs are already in the JSONL, so this needs no Supabase env —
// only ANTHROPIC_API_KEY, which lives in .env.local (not the public-feed file).
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}

const anthropic = new Anthropic()   // ANTHROPIC_API_KEY / auth profile

/**
 * The frame gate asks ONLY for ordinal facts anchored on the entry marker.
 * Never a price, never a time, never a level — those come from bars, and the
 * measured failure mode of vision on this app's charts is exactly numbers
 * (Pt 18: low-confidence stop reads landed 1/10 exact, median 6pt off).
 */
const GATE_PROMPT = `You are looking at a screenshot a futures trader captured around one of their own trades. It is a Sierra Chart layout, usually two panes: order-flow/footprint on the left, candles and volume profile on the right.

This image is evidence of WHAT WAS ON THEIR SCREEN. It is not a source of prices. You will never be asked for a price, a level, or a time, and you must never report one.

Answer only what you can see. Every field has an "unknown" or false option and you are expected to use it — a confident wrong answer is worse than an honest "I can't tell". You are not being scored on how much you can identify.

Definitions:
- "Entry marker": the broker/platform indicator of the trader's own position on the chart — an arrow, a triangle, a position line, a filled-order tag. NOT a drawn trendline and NOT a horizontal level.
- "chart_right_of_entry": of the price action visible in the candle pane, roughly how much sits to the RIGHT of the entry marker (later in time). "none" = the entry is at or within a bar or two of the right edge. "some" = a modest amount, well under half the visible window. "most" = the entry sits in the left half and the chart runs well past it.
- "shows_completed_trade": can you see that this trade is FINISHED — meaning BOTH an entry marker AND a separate exit/close marker on the same position, or an explicit flat/closed-position tag. IMPORTANT: a P&L number on or near the position line is NOT evidence of completion — this platform paints the OPEN, unrealised P&L on a live position, so a dollar figure is what an open trade looks like. Do not answer "yes" on the strength of a P&L readout, a profit banner, or a dollar amount anywhere on the chart. "no" means you can see it is still open or you can see only an entry. "unknown" means you genuinely cannot tell.
- "drawn_annotations": marks the trader drew themselves (trendlines, boxes, zones, arrows, text), not platform chrome.`

const SCHEMA = {
  type: 'object',
  properties: {
    entry_marker_visible: { type: 'boolean' },
    entry_marker_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    chart_right_of_entry: { type: 'string', enum: ['none', 'some', 'most', 'unknown'] },
    shows_completed_trade: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    price_scale_readable: { type: 'boolean' },
    footprint_pane_present: { type: 'boolean' },
    footprint_pane_annotated: { type: 'boolean' },
    drawn_annotations: { type: 'string', enum: ['none', 'lines', 'boxes', 'arrows', 'mixed'] },
    note: { type: 'string', description: 'One sentence on what is visible. No prices, levels, or times.' },
  },
  required: [
    'entry_marker_visible', 'entry_marker_confidence', 'chart_right_of_entry',
    'shows_completed_trade', 'price_scale_readable', 'footprint_pane_present',
    'footprint_pane_annotated', 'drawn_annotations', 'note',
  ],
  additionalProperties: false,
} as const

interface GateRead {
  entry_marker_visible: boolean
  entry_marker_confidence: 'high' | 'medium' | 'low'
  chart_right_of_entry: 'none' | 'some' | 'most' | 'unknown'
  shows_completed_trade: 'yes' | 'no' | 'unknown'
  price_scale_readable: boolean
  footprint_pane_present: boolean
  footprint_pane_annotated: boolean
  drawn_annotations: 'none' | 'lines' | 'boxes' | 'arrows' | 'mixed'
  note: string
}

type MediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
function mediaTypeOf(path: string): MediaType {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

async function readGate(url: string, path: string): Promise<GateRead | { error: string }> {
  const res = await fetch(url)
  if (!res.ok) return { error: `image fetch ${res.status}` }
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    // Scoped ordinal extraction — this is not a reasoning task, and Sonnet 5
    // runs adaptive thinking whenever `thinking` is omitted. Low effort keeps
    // the pass cheap without touching what the model can see.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaTypeOf(path), data: b64 } },
        { type: 'text', text: GATE_PROMPT },
      ],
    }],
  })

  if (msg.stop_reason === 'refusal') return { error: 'refusal' }
  const text = msg.content.find(b => b.type === 'text')
  if (!text || text.type !== 'text') return { error: `no text block (stop_reason=${msg.stop_reason})` }
  try { return JSON.parse(text.text) as GateRead }
  catch { return { error: 'unparseable json' } }
}

async function main() {
  const rows = readFileSync(IN_PATH, 'utf8').trim().split('\n')
    .map(l => JSON.parse(l) as Record<string, any>)   // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter(r => r.frame?.signed_url)

  // The control first, then a spread of unknowns across both capture sources —
  // OBS and manual are written by different paths and there is no reason to
  // assume they frame a trade the same way.
  const control = rows.filter(r => r.frame.proven_pre_exit)
  const unknown = rows.filter(r => !r.frame.proven_pre_exit)
  const obs = unknown.filter(r => r.frame.capture_source === 'obs')
  const manual = unknown.filter(r => r.frame.capture_source === 'manual')
  const want = Math.max(0, LIMIT - control.length)
  const spread: Record<string, unknown>[] = []
  for (let i = 0; i < Math.ceil(want / 2); i++) {
    if (obs[i]) spread.push(obs[i])
    if (manual[i] && spread.length < want) spread.push(manual[i])
  }
  const batch = [...control, ...spread.slice(0, want)]

  console.log(`model=${MODEL}  images=${batch.length}  (control=${control.length}, unknown=${batch.length - control.length})\n`)

  const out: Record<string, unknown>[] = []
  for (const [i, r] of batch.entries()) {
    const read = await readGate(r.frame.signed_url, r.frame.storage_path ?? '')
    const isErr = 'error' in read
    out.push({
      trade_id: r.trade_id,
      date: r.date,
      entry_pt: r.entry_pt,
      capture_source: r.frame.capture_source,
      proven_pre_exit: r.frame.proven_pre_exit,
      read: isErr ? null : read,
      error: isErr ? (read as { error: string }).error : null,
    })
    const tag = r.frame.proven_pre_exit ? 'CONTROL' : 'unknown'
    console.log(
      `[${String(i + 1).padStart(2)}/${batch.length}] ${r.date} ${String(r.frame.capture_source).padEnd(6)} ${tag.padEnd(7)} ` +
      (isErr ? `ERROR ${(read as { error: string }).error}`
        : `marker=${read.entry_marker_visible ? read.entry_marker_confidence : 'no'} ` +
          `right=${read.chart_right_of_entry} completed=${read.shows_completed_trade}`),
    )
  }

  // ── the only scoreable question ────────────────────────────────────────
  const ctl = out.filter(o => o.proven_pre_exit && o.read)
  const falseAlarms = ctl.filter(o => (o.read as GateRead).shows_completed_trade === 'yes')
  const ctlUnknown = ctl.filter(o => (o.read as GateRead).shows_completed_trade === 'unknown').length
  const good = out.filter(o => o.read)
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : '—')

  const bySource = (src: string) => {
    const g = good.filter(o => o.capture_source === src)
    const marker = g.filter(o => (o.read as GateRead).entry_marker_visible).length
    const scale = g.filter(o => (o.read as GateRead).price_scale_readable).length
    const fp = g.filter(o => (o.read as GateRead).footprint_pane_present).length
    const ann = g.filter(o => (o.read as GateRead).drawn_annotations !== 'none').length
    return `  ${src.padEnd(7)} n=${String(g.length).padEnd(3)} entry marker ${pct(marker, g.length).padStart(4)}   ` +
           `scale ${pct(scale, g.length).padStart(4)}   footprint ${pct(fp, g.length).padStart(4)}   annotated ${pct(ann, g.length).padStart(4)}`
  }

  const report = [
    `FRAME-GATE CALIBRATION — ${MODEL}`,
    ``,
    `POSITIVE CONTROL  (files provably written before the exit — the image CANNOT show a finished trade)`,
    `  control images read        ${ctl.length}`,
    `  said "completed trade"     ${falseAlarms.length}  << FALSE ALARMS — provably wrong`,
    `  said "unknown"             ${ctlUnknown}  (honest, not a failure)`,
    `  false-alarm rate           ${pct(falseAlarms.length, ctl.length)}`,
    falseAlarms.length === 0
      ? `  >> Gate did not invent a finished trade on any image that predates its exit.`
      : `  >> Gate INVENTS. Its reads on the unknowns cannot be trusted as-is.`,
    ...falseAlarms.map(o => `     ${o.date} ${o.entry_pt} — "${(o.read as GateRead).note}"`),
    ``,
    `WHAT THE GATE SEES  (descriptive; no ground truth for these)`,
    bySource('obs'),
    bySource('manual'),
    ``,
    `UNSCORED — footprint reads collected for the axis-3 decision, not graded here.`,
    `errors: ${out.filter(o => o.error).length}`,
  ].join('\n')

  const outPath = join(dirname(IN_PATH), 'frame-gate-reads.jsonl')
  writeFileSync(outPath, out.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  writeFileSync(join(dirname(IN_PATH), 'frame-gate-report.txt'), report + '\n', 'utf8')
  console.log('\n' + report)
  console.log(`\nwrote ${outPath}`)
}

mkdirSync(dirname(IN_PATH), { recursive: true })
main().catch(e => { console.error(e); process.exit(1) })
