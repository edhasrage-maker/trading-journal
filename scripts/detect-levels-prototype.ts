/**
 * Prototype: detect entry / stop / TP levels from an OBS recording frame.
 *
 * Usage:
 *   npx tsx scripts/detect-levels-prototype.ts <trade_id> [--recording=FILE.mp4]
 *
 *   <trade_id>  UUID of a row in `trades`. Script will pull entry_time
 *               and (if present) the linked recording filename from
 *               recording_commentary.video_file.
 *   --recording Override / supply the recording filename when the trade
 *               doesn't carry one yet. Bare filename in OBS_RECORDINGS_DIR.
 *
 * Pipeline:
 *   1. Fetch the trade (need entry_time + the chosen recording).
 *   2. probeVideo() → recording start time + duration.
 *   3. extractFrameJpegBase64() at (entry_time − recording_start), with a
 *      small back-off (−2s) so the chart shows the levels JUST BEFORE the
 *      fill (when active orders are still drawn, not after the entry fills
 *      and the working stop becomes a position-stop).
 *   4. Send to Claude sonnet 4.6 with vision + structured output:
 *        { entry_price, stop_price, tp1_price, tp2_price, confidence,
 *          reasoning }
 *      Each price field is nullable — model returns null when not confidently
 *      visible rather than guessing.
 *   5. Print the result + the trade's actual recorded values side-by-side
 *      for accuracy eyeballing.
 *
 * This is a prototype — NOT wired to the UI yet. Run it on a few trades
 * where you remember the levels but didn't screenshot, eyeball accuracy,
 * then decide whether to promote to a /api/video/detect-levels route +
 * EOD-row button.
 */

import { readFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { probeVideo, extractFrameJpegBase64 } from '../src/lib/video-frames.ts'

// Load .env.local
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const OBS_RECORDINGS_DIR = process.env.OBS_RECORDINGS_DIR || 'C:\\Users\\lamed\\Videos'

const argv = process.argv.slice(2)
const tradeId = argv.find(a => !a.startsWith('--'))
const recordingOverride = argv.find(a => a.startsWith('--recording='))?.split('=')[1]

if (!tradeId) {
  console.error('Usage: npx tsx scripts/detect-levels-prototype.ts <trade_id> [--recording=FILE.mp4]')
  process.exit(1)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)
const anthropic = new Anthropic()

interface DetectedLevels {
  entry_price: number | null
  stop_price: number | null
  tp1_price: number | null
  tp2_price: number | null
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
}

const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function fmtPT(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const p: Record<string, string> = {}
  for (const x of PT_FMT.formatToParts(new Date(ms))) p[x.type] = x.value
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} PT`
}

async function main() {
  console.log(`Trade id: ${tradeId}\n`)

  const { data: trade, error } = await sb
    .from('trades')
    .select('id, entry_time, entry_price, stop_price, direction, quantity, exits_json, recording_commentary, tags_json')
    .eq('id', tradeId)
    .single()

  if (error || !trade) {
    console.error(`Trade not found: ${error?.message || 'no row'}`)
    process.exit(1)
  }

  console.log(`  entry_time:    ${trade.entry_time}  (${fmtPT(trade.entry_time)})`)
  console.log(`  direction:     ${trade.direction}`)
  console.log(`  entry_price:   ${trade.entry_price}`)
  console.log(`  stop_price:    ${trade.stop_price}`)
  const legs = Array.isArray(trade.exits_json) ? trade.exits_json : []
  for (let i = 0; i < legs.length; i++) {
    console.log(`  leg ${i + 1} exit:    ${legs[i].price}  @  ${legs[i].time}`)
  }
  console.log()

  // Resolve recording filename
  let videoFile = recordingOverride
  if (!videoFile) {
    // recording_commentary may be stored either as a parsed object OR a JSON
    // string (Supabase column is jsonb-or-text legacy). Handle both.
    let rc = trade.recording_commentary
    if (typeof rc === 'string') {
      try { rc = JSON.parse(rc) } catch { rc = null }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (rc && typeof rc === 'object' && (rc as any).video_file) videoFile = (rc as any).video_file
  }
  if (!videoFile) {
    console.error('No recording linked. Pass --recording=FILE.mp4 to specify one.')
    process.exit(1)
  }
  const safe = basename(videoFile)
  const fullPath = join(OBS_RECORDINGS_DIR, safe)
  if (!existsSync(fullPath)) {
    console.error(`Recording not found: ${fullPath}`)
    process.exit(1)
  }
  console.log(`Recording: ${safe}`)

  const info = await probeVideo(fullPath)
  console.log(`  recording start: ${new Date(info.creationTimeMs).toISOString()}  (${fmtPT(new Date(info.creationTimeMs).toISOString())})`)
  console.log(`  duration:        ${(info.durationMs / 1000).toFixed(0)}s`)

  const entryMs = Date.parse(trade.entry_time)
  // Back off 2s — we want the chart at "just before the fill", when working
  // orders are still drawn as horizontal DOM lines. After fill, Sierra may
  // consolidate them into a position-stop indicator that's harder to read.
  const offsetSec = (entryMs - info.creationTimeMs) / 1000 - 2
  if (offsetSec < 0 || offsetSec > info.durationMs / 1000) {
    console.error(`Entry offset ${offsetSec.toFixed(1)}s is outside recording window (0–${(info.durationMs / 1000).toFixed(0)}s).`)
    process.exit(1)
  }
  console.log(`  frame offset:    ${offsetSec.toFixed(1)}s (entry − 2s)\n`)

  console.log('Extracting frame…')
  const frameBase64 = await extractFrameJpegBase64(fullPath, offsetSec)
  console.log(`  ${(frameBase64.length / 1024).toFixed(0)} KB base64\n`)

  console.log('Asking Claude sonnet to identify levels…')
  const prompt = `You are looking at a Sierra Chart screenshot from a futures trader's screen recording, taken approximately 2 seconds before they entered a ${trade.direction ?? 'long/short'} trade.

Your job: identify the EXACT price levels of any visible horizontal lines on the chart that look like working orders or planned trade levels. Specifically:

1. ENTRY — where the trader was about to enter. Look for a horizontal line at the price they were waiting for, or a clear price-action level (cluster of bids/offers, key swing high/low, EMA touch) that the entry order is targeting.
2. STOP — a horizontal line, typically labeled "Stop" or in a distinct color (often red), placed BELOW entry for a long or ABOVE for a short.
3. TP1 / TP2 — horizontal lines, often labeled "Limit" or "TP", placed ABOVE entry for a long or BELOW for a short. TP1 is the closer one to entry.

CRITICAL RULES:
- If you cannot confidently read a price off the right-hand price scale, return null for that field. DO NOT guess.
- Reading the actual numeric price from the y-axis ticks is required — eyeballing approximate values is not acceptable.
- The trader recorded actual entry=${trade.entry_price ?? '?'} stop=${trade.stop_price ?? '?'} — use this as a sanity check that the levels you identify are in the right ballpark, but the chart is the source of truth. If the chart shows different levels than the recorded values, trust the chart and explain in reasoning.
- "confidence" should be: "high" only if every non-null field came from a clearly-labeled order line at a readable price; "medium" if levels were inferred from line position; "low" if the chart was zoomed wrong / lines weren't visible.

In reasoning, briefly describe what each line looked like (color, label, position) so the user can sanity-check.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frameBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            entry_price: { type: ['number', 'null'] },
            stop_price: { type: ['number', 'null'] },
            tp1_price: { type: ['number', 'null'] },
            tp2_price: { type: ['number', 'null'] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            reasoning: { type: 'string' },
          },
          required: ['entry_price', 'stop_price', 'tp1_price', 'tp2_price', 'confidence', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (message.content[0] as any).text as string
  let parsed: DetectedLevels
  try { parsed = JSON.parse(text) }
  catch (e) {
    console.error('Failed to parse model output:', e)
    console.error('Raw:', text)
    process.exit(1)
  }

  // Implied pts-from-entry for the detected levels — lets you sanity check
  // the model's reads at a glance even when there's no recorded ground truth
  // (a stop "at +20p above entry" for a short is the easy eye-test). The sign
  // is "adverse" for stop, "favorable" for TPs.
  const isLong = trade.direction === 'long'
  const fmtFromEntry = (p: number | null, kind: 'stop' | 'tp'): string => {
    if (p == null || trade.entry_price == null) return ''
    const raw = p - trade.entry_price
    // Adverse direction = stop direction; favorable = TP direction.
    const adverse = isLong ? -raw : raw   // for short, stop ABOVE entry = positive raw = adverse-favored
    const favorable = isLong ? raw : -raw
    const pts = kind === 'stop' ? adverse : favorable
    const sign = pts >= 0 ? '+' : ''
    return `  (${sign}${pts.toFixed(2)}p ${kind === 'stop' ? 'adverse' : 'favorable'})`
  }

  console.log()
  console.log('Detection result:')
  console.log(`  confidence:  ${parsed.confidence}`)
  console.log(`  entry:       ${parsed.entry_price ?? '—'}    (recorded: ${trade.entry_price ?? '—'})`)
  console.log(`  stop:        ${parsed.stop_price ?? '—'}    (recorded: ${trade.stop_price ?? '—'})${fmtFromEntry(parsed.stop_price, 'stop')}`)
  console.log(`  tp1:         ${parsed.tp1_price ?? '—'}${fmtFromEntry(parsed.tp1_price, 'tp')}`)
  console.log(`  tp2:         ${parsed.tp2_price ?? '—'}${fmtFromEntry(parsed.tp2_price, 'tp')}`)
  console.log()
  console.log(`Reasoning: ${parsed.reasoning}`)

  // Realized exit context (NOT a delta vs detected TPs — leg exits and planned
  // TPs are different concepts; the trader might have been stopped out, scratched,
  // or trailed). Just print for sanity reading.
  if (legs.length > 0) {
    console.log()
    console.log('For reference — actual realized exits (not the same as planned TPs):')
    for (let i = 0; i < legs.length; i++) {
      const pts = trade.entry_price != null ? (isLong ? legs[i].price - trade.entry_price : trade.entry_price - legs[i].price) : null
      const sign = pts != null && pts >= 0 ? '+' : ''
      console.log(`  leg ${i + 1} exit:   ${legs[i].price}${pts != null ? `  (${sign}${pts.toFixed(2)}p realized)` : ''}`)
    }
  }

  // Real deltas only on fields we actually store: entry and stop.
  const deltas: string[] = []
  if (parsed.entry_price != null && trade.entry_price != null)
    deltas.push(`entry Δ ${(parsed.entry_price - trade.entry_price).toFixed(2)}`)
  if (parsed.stop_price != null && trade.stop_price != null)
    deltas.push(`stop Δ ${(parsed.stop_price - trade.stop_price).toFixed(2)}`)
  if (deltas.length) console.log(`\nGround-truth deltas: ${deltas.join(', ')}`)
}

main().catch(e => { console.error(e); process.exit(1) })
