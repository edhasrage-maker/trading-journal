export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      trading_days: {
        Row: {
          id: string
          date: string
          chart_screenshot_url: string | null
          day_type: string | null         // Legacy single primary — kept in sync as day_types[0] for backward compat with analytics + predict-day-type
          day_types: string[] | null      // Multi-select array (post-2026-06-03 migration). New code should read this, falling back to day_type when empty/null.
          prep_notes_json: PrepNotes
          ai_analysis_json: AiAnalysis
          eod_notes: string | null
          eod_pnl: number | null
          // Set when the trader manually ends the session during RTH (Pt 13
          // step 3). NULL = never manually ended. Never cleared after a re-open.
          session_ended_at: string | null
          eod_chart_screenshot_url: string | null
          chart_calibration_json: ChartCalibration | null
          eod_ai_analysis_json: EodAiAnalysis
          // Gamification Phase 2: earned achievement ids for the day (values are
          // AchievementId from '@/lib/achievements' — typed loosely here to avoid
          // a types→achievements→analytics→types import cycle).
          achievements_json: string[] | null
          last_sc_import_at: string | null
          last_sc_import_filename: string | null
          prep_started_at: string | null
          prep_completed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['trading_days']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['trading_days']['Insert']>
      }
      market_context: {
        Row: {
          id: string
          trading_day_id: string
          symbol: string
          pdh: number | null
          pdl: number | null
          ibh: number | null
          ibl: number | null
          onh: number | null
          onl: number | null
          rvol: number | null
          rvol_flag: 'red' | 'yellow' | 'green' | null
          ib_size: number | null
          ib_10d_avg: number | null
          ib_vs_10d_avg: number | null
          adr: number | null
          adr_flag: 'red' | 'yellow' | 'green' | null
          // Day's Range from Sierra Chart stats overlay (points). Used to
          // compute DR_ADR = day_range / adr without needing 1-min bars.
          day_range: number | null
          gbx_pct_adr: number | null
          atr_1m: number | null
          atr_flag: 'red' | 'yellow' | 'green' | null
          price_in_pd_range: boolean | null
          price_in_gbx_range: boolean | null
          // IB day-type Phase 2 (Pt 23) — the day-CHARACTER read, classified
          // honestly at the 07:29 PT IB close. RTH only, and only on the
          // study-exact meanHL10 basis; see ib-day-type.ts.
          ib_meanhl10: number | null      // mean(H-L) of the last 10 IB 1m bars
          ib_atr_ratio: number | null     // ib_size / ib_meanhl10 — the IB_ATR lookup metric
          ib_regime: 'chop' | 'mid' | 'expanded' | null
          ib_size_band: 'small' | 'normal' | 'large' | null
          stat_performance_json: StatPerformance
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['market_context']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['market_context']['Insert']>
      }
      trades: {
        Row: {
          id: string
          trading_day_id: string
          entry_time: string | null
          entry_price: number | null
          stop_price: number | null
          tp1_price: number | null
          direction: 'long' | 'short' | null
          quantity: number | null
          pnl: number | null
          screenshot_url: string | null
          entry_pin_x: number | null
          entry_pin_y: number | null
          stop_pin_x: number | null
          stop_pin_y: number | null
          tp1_pin_x: number | null
          tp1_pin_y: number | null
          sierra_trade_id: string | null
          symbol: string | null
          high_during_position: number | null
          low_during_position: number | null
          // Post-exit continuation (30-min window after exit), points, direction-
          // relative. favorable = continued the trade's way; against = reversed.
          // Market-sense/directional-read signal, NOT an exit-timing grade.
          // Migration: 20260705_trades_post_exit.sql. Backfill: scripts/backfill-post-exit.ts.
          post_exit_favorable_pts: number | null
          post_exit_against_pts: number | null
          /** 5m structure alignment at entry — was the trade following or
           *  fading the 5m EMA-20 trend? Auto-populated at SC-import time;
           *  null when bars are missing or fewer than 20 5m bars exist
           *  before entry. */
          structure_5m_alignment: 'following' | 'fading' | 'neutral' | null
          /** Pin a P&L + execution-score chip above this trade on the chart.
           *  Persisted (not localStorage) because the point is that a viewer of
           *  a shared link sees it; the label itself is derived at render time
           *  so an edited trade or a re-run analysis can't leave a stale
           *  callout. Migration: 20260728_trade_highlighted.sql. */
          highlighted: boolean | null
          exits_json: TradeExit[] | null
          tags_json: TradeTags
          notes: string | null
          exit_time: string | null
          exit_price: number | null
          // `string` is the legacy shape from a few June 1 rows written before
          // the object format landed — kept in the type so the client can
          // safely read those rows until the one-shot normalizer cleans them up.
          recording_commentary: RecordingCommentaryData | string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['trades']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['trades']['Insert']>
      }
      trade_tags: {
        Row: {
          id: string
          category: TagCategory
          label: string
          sort_order: number
          // Free-text definition. Used by /api/predict-day-type to give the
          // AI a precise classification rubric per label. Null when unset.
          description: string | null
          // Alternative phrasings that should auto-select this tag from notes.
          // A label is a PHRASE ("VWAP Hold/Bounce") but notes are prose
          // ("the volatility at VWAP"), and the matcher requires EVERY
          // significant word of the label — so the tag never fires. Aliases are
          // the deterministic fix, editable in Settings → Tags.
          // Kept OFF `description`, which is injected verbatim into the
          // predict-day-type prompt as a rubric and must not carry matcher data.
          // Migration: 20260728_tag_aliases.sql. Null when never set.
          aliases: string[] | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['trade_tags']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['trade_tags']['Insert']>
      }
      performance_stats: {
        Row: {
          id: string
          category: StatCategory
          label: string
          range_low: number | null
          range_high: number | null
          stat_data_json: StatData
          sort_order: number
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['performance_stats']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['performance_stats']['Insert']>
      }
      ohlcv_bars: {
        Row: {
          symbol: string
          ts: string           // timestamptz ISO string
          open: number
          high: number
          low: number
          close: number
          volume: number | null
        }
        Insert: Database['public']['Tables']['ohlcv_bars']['Row']
        Update: Partial<Database['public']['Tables']['ohlcv_bars']['Insert']>
      }
      bar_imports: {
        Row: {
          id: string
          symbol: string
          granularity: BarGranularity
          date_range_start: string  // date
          date_range_end: string    // date
          rows_inserted: number | null
          rows_updated: number | null
          source_filename: string | null
          imported_at: string       // timestamptz ISO string
        }
        Insert: Omit<Database['public']['Tables']['bar_imports']['Row'], 'id' | 'imported_at'>
        Update: Partial<Database['public']['Tables']['bar_imports']['Insert']>
      }
    }
  }
}

export type OhlcvBar = Database['public']['Tables']['ohlcv_bars']['Row']
export type BarImport = Database['public']['Tables']['bar_imports']['Row']
/**
 * Bar granularity stored alongside each ohlcv_bars row's `symbol` only via the
 * import history table (bar_imports). The bars themselves are 1-minute
 * canonical per Phase 0 decision — coarser granularities (5m/15m/1h) are
 * aggregated on the fly at render time. Keeping this as a string union now so
 * if we ever decide to denormalize for performance, the type is ready.
 */
export type BarGranularity = '1m' | '5m' | '15m' | '1h' | '1d'

/** The taxonomy axes TapeScore ships with. */
export type BuiltinTagCategory =
  | 'setups' | 'confluences' | 'order_flow' | 'entry_model'
  | 'trade_management' | 'day_type' | 'mistakes' | 'emotions'

/**
 * A tag category key. OPEN by design (Pt 16): a trader can add their own axis
 * ("4h Candle Shape") from Settings → Tags, so this is any snake_case slug —
 * `src/lib/tag-categories.ts` owns the resolver and the shape rules. The
 * `(string & {})` half keeps the built-in names autocompleting while letting a
 * custom key through anywhere a category is accepted.
 */
export type TagCategory = BuiltinTagCategory | (string & {})
export type StatCategory = 'rvol' | 'ib_sizing' | 'adr' | 'atr'

/** One row of the "Where price can go" roadmap. `role` orders the card
 *  (favored first); `direction` colors the arrow; trigger/target are free text
 *  so the admin can write "28910" or "IB low". */
export interface PriceScenario {
  role: 'favored' | 'alt'
  direction: 'up' | 'down'
  trigger: string
  target: string
}

export interface TradePlan {
  id: string
  direction: 'long' | 'short'
  setup_name: string
  quality: number
  quality_reasons: string[]
  invalidation: string
  targets: string
  scary_factors: string
}

export interface PlanAssessment {
  plan_id: string
  ai_quality: number
  note: string
}

export interface PrepNotes {
  ib_behaviour?: string
  ib_extensions_reached?: string[]
  volume_profile_shape?: string
  volume_profile_notes?: string
  bias?: 'bullish' | 'bearish' | 'neutral'
  bias_notes?: string
  setups_areas?: string
  trade_plans?: TradePlan[]
  htf_mgi?: Record<string, 'above' | 'below'>
  htf_mgi_reactive?: string[]
  vwap_slope?: 'flat' | 'sloped'
  ema_slope?: 'flat' | 'sloped'
  mood?: string
  market_clarity?: string
  /** Viewer-facing verdict for the Discord share card — a plain-language day
   *  "stance" (traffic-light) plus a one-line read. Entered by the admin so the
   *  card stays meaningful even when the bar feed hasn't auto-filled the stats. */
  day_stance?: 'go' | 'caution' | 'avoid'
  day_read?: string
  /** "Where price can go" roadmap: a favored path + optional alternate, each a
   *  trigger→target in the trader's own words. Rendered as if/then rows on the
   *  Discord card. */
  price_scenarios?: PriceScenario[]
  /** Which trading session this prep targets — drives session-aware levels/IB
   *  on the Prep page. RTH (default) is the day session; Asia/London are the
   *  GBX/overnight sessions. Persisted here so no schema change is needed. */
  session?: 'rth' | 'asia' | 'london'
  /** Who the day stance belongs to. TapeScore suggests it from conditions; the
   *  trader owns it. 'trader' means they set or overrode it deliberately — the
   *  Prep hero shows that provenance so the app never sounds like the
   *  authority on someone else's decision (Pt 13 R2). */
  day_stance_source?: 'suggested' | 'trader'
  /** The trader's reason when they override the suggested stance. */
  day_stance_reason?: string
  /** The Review → Prep commitment the trader chose to track today. Written when
   *  they hit "Track this today" / "Protect this today"; resolved at review
   *  time. This is the loop the whole bridge exists for — a displayed focus
   *  that nobody resolves is just a label. */
  commitment?: PrepCommitment
}

/** One tracked commitment carried from a review finding into a session. */
export interface PrepCommitment {
  /** Stable identity of the source finding (e.g. "setup:Opening pullback"). */
  key: string
  /** 'protect' = an edge to keep; 'correct' = a leak to avoid. */
  mode: 'protect' | 'correct'
  /** Window the finding came from, e.g. "July review". */
  source: string
  /** The measured fact, and the number behind it — snapshotted so the
   *  commitment still reads correctly after the underlying stats move on. */
  finding: string
  metric: string
  /** What the trader committed to doing today. */
  today: string
  tracked_at: string
  /** Set at review time once the session is graded against the commitment. */
  resolved?: 'followed' | 'not_followed'
  resolved_at?: string
}

export interface AiAnalysis {
  summary?: string
  chart_thesis?: string
  chart_structure_notes?: string[]
  flags?: string[]
  strengths?: string[]
  score?: number
  analyzed_at?: string
  plan_assessments?: PlanAssessment[]
  /** Viewer-facing verdict for the Discord card, generated by analyze-prep from
   *  market conditions (NOT prep quality). Copied into PrepNotes.day_stance /
   *  day_read on Analyze, where the admin can override them. */
  day_stance?: 'go' | 'caution' | 'avoid'
  day_read?: string
}

export interface StatPerformance {
  rvol?: StatPerformanceBucket
  ib_size?: StatPerformanceBucket
  adr?: StatPerformanceBucket
  atr?: StatPerformanceBucket
}

export interface StatPerformanceBucket {
  label: string
  win_rate: number
  avg_r: number
}

/**
 * One closing fill in a multi-leg exit. SC log writes a separate fill row
 * per scale-out; the importer collects them all into `trades.exits_json` so
 * charts can render each partial as its own marker (vs the aggregated
 * weighted-average in `exit_time` / `exit_price`).
 */
export interface TradeExit {
  time: string  // ISO-8601
  price: number
  qty: number
}

/** AI-generated OBS recording commentary saved per-trade so it survives
 *  reloads and syncs across PCs. Stored as jsonb on trades.recording_commentary. */
export interface RecordingCommentaryData {
  text: string                // The Claude-authored 1-3 sentence commentary
  video_file: string          // Source recording filename — lets the UI flag stale commentary if the user re-runs against a different recording
  model: string               // Which Claude model produced it (e.g. claude-sonnet-4-6)
  generated_at: string        // ISO timestamp of when this was saved
  detected_levels?: DetectedLevels  // Vision-extracted planned levels from the entry frame. Optional — old commentary rows predate this and the model can return all-null when no working orders were visible.
}

/** Vision-detected planned trade levels read off the entry frame of the OBS
 *  recording. Populated by /api/video/commentary alongside the text commentary
 *  (one Claude call returns both). Each price field is nullable — the model
 *  returns null rather than guess when a level isn't confidently readable.
 *  The user reviews and applies them to stop_price / tp1 / tp2 fields manually
 *  via the EOD UI; never auto-written. */
export interface DetectedLevels {
  entry_price: number | null
  stop_price: number | null
  tp1_price: number | null
  tp2_price: number | null
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
}

export interface TradeTags {
  setups?: string[]
  confluences?: string[]
  order_flow?: string[]
  entry_model?: string[]
  trade_management?: string[]
  /**
   * Multi-select. Legacy rows may have this as a single string in the database;
   * always normalise via `normalizeTagArray(tags.day_type)` when reading.
   */
  day_type?: string[]
  mistakes?: string[]
  emotions?: string[]
  /**
   * Custom categories (Pt 16). `tags_json` is JSONB, so a trader-defined axis
   * is just another key — no schema change per category. The union covers the
   * legacy single-string `day_type` shape too; always read through
   * `normalizeTagArray()`.
   */
  [category: string]: string[] | string | undefined
}

/**
 * Normalise a tag-category value to a string array, tolerating legacy
 * single-string values (e.g. old day_type rows) and missing values.
 */
export function normalizeTagArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

export interface StatData {
  win_rate?: number
  avg_r?: number
  sample_size?: number
  notes?: string
}

// ============================================================
// Phase 5: EOD Recap
// ============================================================

export interface CalibrationAnchor {
  x_pct: number
  y_pct: number
}

export interface PriceAnchor extends CalibrationAnchor {
  price: number
}

export interface TimeAnchor extends CalibrationAnchor {
  time: string // 'HH:MM'
}

export interface ChartCalibration {
  high: PriceAnchor
  low: PriceAnchor
  start: TimeAnchor
  end: TimeAnchor
  calibrated_at: string
}

/**
 * EOD AI analysis output.
 *
 * v1.3 split: under the new ruleset, the EOD AI produces TWO orthogonal
 * verdicts in addition to the qualitative analysis:
 *
 *   - `process`: binary per-rule verdict (Compliant vs Breach). Any one
 *     breach = Breach for the session. Magnitude doesn't matter; PnL
 *     doesn't override; no averaging.
 *   - `execution`: continuous diagnostic score (0..1 weighted composite)
 *     computed ONLY over compliant trades. Never blended with process.
 *
 * `score` is kept for backward compatibility with rows analyzed before
 * v1.3 landed (2026-06-08). New analyses populate `process` + `execution`
 * instead; UI prefers those when present, falls back to `score`.
 */
export interface EodAiAnalysis {
  summary?: string
  /** One TapeScore (amendment 5): day verdict sentence, ≤14 words, plain
   *  language, decision quality not P&L. Emitted by new analyses; legacy
   *  rows fall back to the deterministic tapeScoreDaySentence(). */
  headline?: string
  what_worked?: string[]
  mistakes?: string[]
  patterns?: string[]
  next_session_focus?: string[]
  score?: number          // Deprecated post-v1.3. Kept for legacy rows.
  analyzed_at?: string
  process?: ProcessVerdict
  execution?: ExecutionScore
}

/**
 * Per v1.3 amendment 3 (2026-06-08): Process drops to 5 hard safety rails.
 * The old P4 (stop valid) and P7 (setup valid) moved out — they're now
 * scored within Execution Parameters (a 9-criterion sub-metric on the
 * Execution side). Old P5 + P6 (cooldown + trade cap) renumber to P4 + P5.
 *
 * Historical data: pre-amendment rows have P1-P7 keys; this type only
 * captures the new shape. The dashboard's process_v13_score gracefully
 * ignores P-IDs outside the new range when reading legacy data.
 */
export type RuleId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5'

export interface RuleStatus {
  /** 'pass' = compliant. 'fail' = breached. 'incomplete' = data missing.
   *  Per v1.3, P1-P6 incomplete = Breach (safety rails); P7 incomplete =
   *  data-completeness flag, NOT auto-breach. */
  status: 'pass' | 'fail' | 'incomplete'
  /** For per-trade rules (P2/P3/P4/P5/P7), count of trades that breached.
   *  For session-level rules (P1/P6), 1 = breached, 0 = passed. */
  breach_count: number
  /** Brief AI-written explanation for fail/incomplete. Empty on pass. */
  reason?: string
}

export interface ProcessVerdict {
  /** Compliant only if ALL of P1..P7 are pass (with P7 incomplete tolerated
   *  per the spec). */
  verdict: 'Compliant' | 'Breach'
  per_rule: Record<RuleId, RuleStatus>
  /** Which rails this trader actually TRACKS — the ones their scoring profile
   *  defines. Rails they don't track auto-pass in `per_rule` (a trader with no
   *  daily loss limit can't breach one), so without this the Risk axis counted
   *  those free passes as discipline. Absent on rows analyzed before this
   *  existed, and on the founder's build, both of which grade all five.
   *  Empty array = tracks nothing = Risk is not scoreable. */
  active_rails?: RuleId[]
  /** Convenience copy of breach_count per rule. e.g. { P2: 1, P3: 0, ... } */
  breach_count_vector: Record<RuleId, number>
  /** Tight headline summarizing the verdict in ≤15 words, one sentence.
   *  Always visible; the longer notes hide behind "Show details". Optional
   *  for back-compat with rows that predate this field. */
  headline?: string
  /** Freeform AI reasoning on the overall verdict. */
  notes?: string
}

export interface ExecutionScore {
  /** Each sub-metric is 0..1 (higher = better) or null if not computable.
   *  Per v1.3 amendment 4 (2026-06-20) weights:
   *  Execution Parameters 41%, MFE capture 24%, Prep adherence 24%,
   *  profit_factor 11%. Duration-to-thesis was dropped in amendment 3;
   *  MAE heat was dropped from the composite in amendment 4. */
  mfe_capture: number | null
  /** @deprecated Removed from the execution composite in amendment 4
   *  (2026-06-20) — getting stopped, especially when price runs past the
   *  stop, is correct execution validating an invalidated idea, so scoring
   *  it as "heat" penalized a good decision. Kept on the interface because
   *  pre-amendment-4 rows still carry the stored value; it is no longer
   *  weighted, displayed, or computed. Re-run Analyze Session to drop it. */
  mae_heat?: number | null
  /** Did taken trades match the prep (bias, plans, day-character read)? */
  prep_adherence: number | null
  /** Profit Factor — sum(winning realized R) ÷ sum(|losing realized R|).
   *  1.0 = break-even; > 1.0 = net profitable; < 1.0 = net losing.
   *  Replaces planned_vs_realized_rr as of 2026-06-15. */
  profit_factor?: number | null
  /** @deprecated Use profit_factor. Kept for back-compat with rows analyzed
   *  before 2026-06-15. The composite recompute will fall back to this when
   *  profit_factor is missing. */
  planned_vs_realized_rr: number | null
  /** 9-criterion checklist scored 0..1 — mean of per-trade pass rates.
   *  Replaces both the old duration_to_thesis sub-metric AND the moved-out
   *  P4/P7 process rules (stop validity + setup validity). Criteria:
   *  setup-in-playbook, stop in 0.5-1.5 ATR band, TP1 ≥ 2R (or reason),
   *  clear AOI noted, 2/3 OF reads, Break of Cluster/Bubble entry,
   *  chart-not-emotion management, no mistakes tagged, Stable emotion. */
  execution_parameters: number | null
  /** Weighted composite of the four sub-metrics (exec params, MFE, prep, PF).
   *  Null if all inputs are null. */
  composite: number | null
  /** Number of COMPLIANT trades the execution score was computed across.
   *  v1.3: execution never includes breach trades. */
  compliant_trade_count: number
  /** Tight headline summarizing WHY the score was what it was — ≤15 words,
   *  one sentence. Always visible above the per-metric numbers; notes
   *  hidden behind "Show details". Optional for back-compat with rows that
   *  predate this field. */
  headline?: string
  /** AI commentary on execution quality — not a verdict, just diagnostic.
   *  Expanded view only; should be a brief diagnostic narrative, NOT a
   *  calculation trace (those numbers are computed deterministically
   *  server-side). 2-3 sentences max. */
  notes?: string
  /** Optional: per-criterion pass rate for the Execution Parameters sub-metric.
   *  Lets the UI show which criteria are dragging the score down across the
   *  session. Keys mirror the 9-criterion list in the spec. */
  execution_parameter_breakdown?: {
    setup_in_playbook: number | null
    stop_in_atr_band: number | null
    tp1_at_2r_or_reasoned: number | null
    clear_area_of_interest: number | null
    two_thirds_orderflow: number | null
    break_of_cluster_or_bubble_entry: number | null
    chart_not_emotion_management: number | null
    no_mistakes_tagged: number | null
    stable_emotion: number | null
  }
  /** Optional: the PER-TRADE Execution Parameters score, one entry per
   *  compliant trade.
   *
   *  The model has always computed this — the sub-metric above is its mean —
   *  but until 2026-07-27 only the mean was emitted, so there was no per-trade
   *  score anywhere in the data. Persisting it is what lets the UI answer "how
   *  did THIS trade score" instead of only "how did the session score".
   *
   *  `trade_number` is the 1-based index into the trades array as it was passed
   *  to buildEodPrompt — the same array and order the EOD page renders, which is
   *  what makes the mapping safe. Re-ordering that array without re-running the
   *  analysis would silently mis-attribute these.
   *
   *  Absent on every day analyzed before this shipped; the UI must treat missing
   *  as "not scored yet — re-run Analyze Session", never as zero. */
  per_trade?: Array<{
    trade_number: number
    /** 0..1 — passes / (passes + fails), N/A criteria excluded. */
    score: number
    passes: number
    fails: number
    na: number
  }>
}

// ============================================================
// Condition Lookup feature
// ============================================================

// IB_ATR replaced the never-populated ATR_entry (Pt 23, 2026-07-27): it is the
// day-CHARACTER metric, ib_size / meanHL10 — see ib-day-type.ts.
export type ConditionMetric = 'RVOL' | 'DR_ADR' | 'IB' | 'ATR_730' | 'IB_ATR'

export interface ConditionThreshold {
  metric: ConditionMetric
  median: number
  tertile_low: number
  tertile_high: number
  updated_at: string
}

export type ConditionVerdict =
  | 'GREEN_ROBUST'
  | 'GREEN_DIRECTIONAL'
  | 'RED_DIRECTIONAL'
  | 'YELLOW_FLAT_POS'
  | 'YELLOW_FLAT_NEG'
  | 'INSUFFICIENT_DATA'

export type ConditionComboType =
  | 'BASELINE'
  | '1-way_median'
  | '1-way_tertile'
  | '2-way_median'
  | '2-way_tertile'
  | '3-way_median'

export interface ConditionLookupRow {
  condition_id: string
  combo_type: ConditionComboType
  specificity: number              // 0..3
  verdict: ConditionVerdict
  verdict_rank: number             // 1..6
  rvol_b: string
  dr_adr_b: string
  ib_b: string
  atr_730_b: string
  ib_atr_b: string
  n_trades: number | null
  n_sessions: number | null
  n_adequate: boolean | null
  n_reliable: boolean | null
  trade_wr: number | null
  trade_wr_ci_lo: number | null
  trade_wr_ci_hi: number | null
  day_wr: number | null
  ev_per_trade: number | null
  ev_ci_lo: number | null
  ev_ci_hi: number | null
  ev_ci_excludes_zero: boolean | null
  total_pnl: number | null
  profit_factor: number | null
  wr_pval_vs_baseline: number | null
  wr_sig_5pct: boolean | null
  match_priority: number | null
}

export interface DailyPrep {
  trade_date: string
  rvol: number | null
  dr_adr: number | null
  ib: number | null
  atr_730: number | null
  ib_atr: number | null
  matched_median_condition_id: string | null
  matched_tertile_condition_id: string | null
  consolidated_verdict: ConditionVerdict | null
  conflict_flag: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

export type TradingDay = Database['public']['Tables']['trading_days']['Row']
export type MarketContext = Database['public']['Tables']['market_context']['Row']
export type Trade = Database['public']['Tables']['trades']['Row']
export type TradeTag = Database['public']['Tables']['trade_tags']['Row']
export type PerformanceStat = Database['public']['Tables']['performance_stats']['Row']
