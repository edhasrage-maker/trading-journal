export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      trading_days: {
        Row: {
          id: string
          date: string
          chart_screenshot_url: string | null
          day_type: string | null
          prep_notes_json: PrepNotes
          ai_analysis_json: AiAnalysis
          eod_notes: string | null
          eod_pnl: number | null
          eod_chart_screenshot_url: string | null
          chart_calibration_json: ChartCalibration | null
          eod_ai_analysis_json: EodAiAnalysis
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
          gbx_pct_adr: number | null
          atr_1m: number | null
          atr_flag: 'red' | 'yellow' | 'green' | null
          price_in_pd_range: boolean | null
          price_in_gbx_range: boolean | null
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

export type TagCategory = 'setups' | 'confluences' | 'order_flow' | 'entry_model' | 'trade_management' | 'day_type' | 'mistakes' | 'emotions'
export type StatCategory = 'rvol' | 'ib_sizing' | 'adr' | 'atr'

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

export interface EodAiAnalysis {
  summary?: string
  what_worked?: string[]
  mistakes?: string[]
  patterns?: string[]
  next_session_focus?: string[]
  score?: number
  analyzed_at?: string
}

// ============================================================
// Condition Lookup feature
// ============================================================

export type ConditionMetric = 'RVOL' | 'DR_ADR' | 'IB' | 'ATR_730' | 'ATR_entry'

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
  atr_entry_b: string
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
  atr_entry: number | null
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
