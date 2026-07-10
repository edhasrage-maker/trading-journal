/**
 * Server-side reader for the user's chosen ATR measurement (stored on
 * trader_profile). Degrades to DEFAULT_ATR_CONFIG when the columns haven't been
 * migrated yet, so callers never break before the migration is applied.
 */
import { normalizeAtrConfig, normalizeGiveBackAtr, DEFAULT_ATR_CONFIG, DEFAULT_GIVE_BACK_ATR, type AtrConfig } from './atr-config'

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

/**
 * The trader's "was up" multiple for the round-trip / give-back metric (×ATR).
 * Stored on trader_profile alongside the ATR-measurement columns. Degrades to
 * DEFAULT_GIVE_BACK_ATR (1×) when the column hasn't been migrated yet, so the
 * coach + EOD never break before the migration is applied.
 */
export async function getGiveBackAtr(supabase: AnyClient): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('trader_profile')
      .select('give_back_atr')
      .eq('id', 'default')
      .maybeSingle()
    if (error || !data) return DEFAULT_GIVE_BACK_ATR
    return normalizeGiveBackAtr(data.give_back_atr)
  } catch {
    return DEFAULT_GIVE_BACK_ATR
  }
}
