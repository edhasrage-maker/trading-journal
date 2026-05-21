import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import Papa from 'papaparse'
import type {
  ConditionLookupRow,
  ConditionThreshold,
  ConditionVerdict,
  ConditionComboType,
} from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Replace the condition lookup tables wholesale from two uploaded CSVs:
 *   - thresholds.csv → condition_thresholds (5 rows)
 *   - lookup.csv     → condition_lookup    (~235 rows)
 *
 * Multipart form: { thresholds: File, lookup: File }
 * Truncates both tables, bulk-inserts new rows, stamps lookup_metadata
 * with `condition_lookup_refreshed_at`.
 */

const REQUIRED_THRESHOLD_COLS = ['metric', 'median', 'tertile_low', 'tertile_high']
const REQUIRED_LOOKUP_COLS = [
  'condition_id', 'combo_type', 'specificity', 'verdict', 'verdict_rank',
  'rvol_b', 'dr_adr_b', 'ib_b', 'atr_730_b', 'atr_entry_b',
]
const VALID_VERDICTS: ConditionVerdict[] = [
  'GREEN_ROBUST', 'GREEN_DIRECTIONAL', 'RED_DIRECTIONAL',
  'YELLOW_FLAT_POS', 'YELLOW_FLAT_NEG', 'INSUFFICIENT_DATA',
]
const VALID_COMBO_TYPES: ConditionComboType[] = [
  'BASELINE', '1-way_median', '1-way_tertile', '2-way_median', '2-way_tertile', '3-way_median',
]

function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function parseBool(v: unknown): boolean | null {
  if (v == null || v === '') return null
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 't' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'f' || s === 'no') return false
  return null
}

function parseInt32(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? Math.trunc(v) : parseInt(String(v), 10)
  return Number.isFinite(n) ? n : null
}

interface ValidationError {
  message: string
}

function validateHeaders(headers: string[], required: string[]): ValidationError | null {
  const missing = required.filter(c => !headers.includes(c))
  if (missing.length > 0) {
    return { message: `Missing required column(s): ${missing.join(', ')}` }
  }
  return null
}

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error('[condition-lookup/upload] failed:', err)
    return NextResponse.json({ error: err.message ?? 'unknown server error' }, { status: 500 })
  }
}

async function handle(req: Request) {
  const supabase: AnyClient = await createClient()
  const formData = await req.formData()
  const thresholdsFile = formData.get('thresholds') as File | null
  const lookupFile = formData.get('lookup') as File | null

  if (!thresholdsFile || !lookupFile) {
    return NextResponse.json(
      { error: 'Both `thresholds` and `lookup` files are required.' },
      { status: 400 },
    )
  }

  // ── Parse thresholds CSV ──────────────────────────────────────────────────
  const thresholdsText = await thresholdsFile.text()
  const tParsed = Papa.parse<Record<string, string>>(thresholdsText, {
    header: true,
    skipEmptyLines: true,
  })
  if (tParsed.errors.length > 0) {
    return NextResponse.json(
      { error: `thresholds.csv parse error: ${tParsed.errors[0].message}` },
      { status: 400 },
    )
  }
  const tHeaderErr = validateHeaders(tParsed.meta.fields ?? [], REQUIRED_THRESHOLD_COLS)
  if (tHeaderErr) return NextResponse.json({ error: `thresholds.csv: ${tHeaderErr.message}` }, { status: 400 })

  const thresholdRows: ConditionThreshold[] = []
  for (const r of tParsed.data) {
    const metric = (r.metric ?? '').trim()
    const median = parseNum(r.median)
    const tlo = parseNum(r.tertile_low)
    const thi = parseNum(r.tertile_high)
    if (!metric || median == null || tlo == null || thi == null) {
      return NextResponse.json(
        { error: `thresholds.csv row invalid: ${JSON.stringify(r)}` },
        { status: 400 },
      )
    }
    thresholdRows.push({
      metric: metric as ConditionThreshold['metric'],
      median,
      tertile_low: tlo,
      tertile_high: thi,
      updated_at: new Date().toISOString(),
    })
  }

  // ── Parse lookup CSV ──────────────────────────────────────────────────────
  const lookupText = await lookupFile.text()
  const lParsed = Papa.parse<Record<string, string>>(lookupText, {
    header: true,
    skipEmptyLines: true,
  })
  if (lParsed.errors.length > 0) {
    return NextResponse.json(
      { error: `lookup.csv parse error: ${lParsed.errors[0].message}` },
      { status: 400 },
    )
  }
  const lHeaderErr = validateHeaders(lParsed.meta.fields ?? [], REQUIRED_LOOKUP_COLS)
  if (lHeaderErr) return NextResponse.json({ error: `lookup.csv: ${lHeaderErr.message}` }, { status: 400 })

  const lookupRows: ConditionLookupRow[] = []
  for (let i = 0; i < lParsed.data.length; i++) {
    const r = lParsed.data[i]
    const condition_id = (r.condition_id ?? '').trim()
    const combo_type = (r.combo_type ?? '').trim() as ConditionComboType
    const verdict = (r.verdict ?? '').trim() as ConditionVerdict
    const specificity = parseInt32(r.specificity)
    const verdict_rank = parseInt32(r.verdict_rank)
    if (!condition_id) {
      return NextResponse.json({ error: `lookup.csv row ${i + 2}: missing condition_id` }, { status: 400 })
    }
    if (!VALID_COMBO_TYPES.includes(combo_type)) {
      return NextResponse.json({ error: `lookup.csv row ${i + 2}: invalid combo_type "${combo_type}"` }, { status: 400 })
    }
    if (!VALID_VERDICTS.includes(verdict)) {
      return NextResponse.json({ error: `lookup.csv row ${i + 2}: invalid verdict "${verdict}"` }, { status: 400 })
    }
    if (specificity == null || verdict_rank == null) {
      return NextResponse.json({ error: `lookup.csv row ${i + 2}: specificity/verdict_rank required` }, { status: 400 })
    }

    lookupRows.push({
      condition_id,
      combo_type,
      specificity,
      verdict,
      verdict_rank,
      rvol_b: (r.rvol_b ?? '').trim() || 'ANY',
      dr_adr_b: (r.dr_adr_b ?? '').trim() || 'ANY',
      ib_b: (r.ib_b ?? '').trim() || 'ANY',
      atr_730_b: (r.atr_730_b ?? '').trim() || 'ANY',
      atr_entry_b: (r.atr_entry_b ?? '').trim() || 'ANY',
      n_trades: parseInt32(r.n_trades),
      n_sessions: parseInt32(r.n_sessions),
      n_adequate: parseBool(r.n_adequate),
      n_reliable: parseBool(r.n_reliable),
      trade_wr: parseNum(r.trade_wr),
      trade_wr_ci_lo: parseNum(r.trade_wr_ci_lo),
      trade_wr_ci_hi: parseNum(r.trade_wr_ci_hi),
      day_wr: parseNum(r.day_wr),
      ev_per_trade: parseNum(r.ev_per_trade),
      ev_ci_lo: parseNum(r.ev_ci_lo),
      ev_ci_hi: parseNum(r.ev_ci_hi),
      ev_ci_excludes_zero: parseBool(r.ev_ci_excludes_zero),
      total_pnl: parseNum(r.total_pnl),
      profit_factor: parseNum(r.profit_factor),
      wr_pval_vs_baseline: parseNum(r.wr_pval_vs_baseline),
      wr_sig_5pct: parseBool(r.wr_sig_5pct),
      match_priority: parseInt32(r.match_priority),
    })
  }

  // ── Truncate + bulk insert ────────────────────────────────────────────────
  // Note: there's no native truncate from supabase-js. We delete then insert.
  // For atomicity we'd need an RPC; this is acceptable for a manual refresh op.
  const { error: delThreshErr } = await supabase.from('condition_thresholds').delete().neq('metric', '__never__')
  if (delThreshErr) {
    return NextResponse.json({ error: `Could not clear thresholds: ${delThreshErr.message}` }, { status: 500 })
  }
  const { error: delLookupErr } = await supabase.from('condition_lookup').delete().neq('condition_id', '__never__')
  if (delLookupErr) {
    return NextResponse.json({ error: `Could not clear lookup: ${delLookupErr.message}` }, { status: 500 })
  }

  const { error: insThreshErr } = await supabase.from('condition_thresholds').insert(thresholdRows)
  if (insThreshErr) {
    return NextResponse.json({ error: `Could not insert thresholds: ${insThreshErr.message}` }, { status: 500 })
  }
  const { error: insLookupErr } = await supabase.from('condition_lookup').insert(lookupRows)
  if (insLookupErr) {
    return NextResponse.json({ error: `Could not insert lookup: ${insLookupErr.message}` }, { status: 500 })
  }

  // ── Stamp vintage ─────────────────────────────────────────────────────────
  const refreshedAt = new Date().toISOString()
  await supabase
    .from('lookup_metadata')
    .upsert(
      { key: 'condition_lookup_refreshed_at', value: { at: refreshedAt }, updated_at: refreshedAt },
      { onConflict: 'key' },
    )

  return NextResponse.json({
    thresholds_inserted: thresholdRows.length,
    lookup_inserted: lookupRows.length,
    refreshed_at: refreshedAt,
  })
}
