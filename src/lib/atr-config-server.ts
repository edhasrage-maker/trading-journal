/**
 * Server-side reader for the user's chosen ATR measurement (stored on
 * trader_profile). Degrades to DEFAULT_ATR_CONFIG when the columns haven't been
 * migrated yet, so callers never break before the migration is applied.
 */
import { normalizeAtrConfig, DEFAULT_ATR_CONFIG, type AtrConfig } from './atr-config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function getAtrConfig(supabase: AnyClient): Promise<AtrConfig> {
  try {
    const { data, error } = await supabase
      .from('trader_profile')
      .select('atr_timeframe, atr_method, atr_period')
      .eq('id', 'default')
      .maybeSingle()
    if (error || !data) return DEFAULT_ATR_CONFIG
    return normalizeAtrConfig({
      timeframe: data.atr_timeframe,
      method: data.atr_method,
      period: data.atr_period,
    })
  } catch {
    return DEFAULT_ATR_CONFIG
  }
}
