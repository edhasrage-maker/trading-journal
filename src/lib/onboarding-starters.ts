/**
 * Starter-setup library for the onboarding "New / still finding my style" path.
 *
 * A one-tap starter seeds the SAME `trade_tags` (setups / confluences / entry
 * model) and `scoring_profile_json` rails that a veteran would type in by hand —
 * no new storage plumbing. Kept deliberately to TWO options so the "totally
 * lost" tapper doesn't hit a second decision wall.
 *
 * The default rules mirror RulesStep's "Use recommended" exactly (1R risk,
 * ~1 ATR stop, 2R target, standard safety rails) so both onboarding paths
 * produce a consistent Coach Score baseline.
 */

export interface StarterSetup {
  key: string
  name: string
  blurb: string
  /** Tags to seed, keyed by trade_tags.category. */
  tags: Partial<Record<'setups' | 'confluences' | 'entry_model' | 'order_flow', string[]>>
}

export const STARTER_SETUPS: StarterSetup[] = [
  {
    key: 'ema-pullback',
    name: 'EMA Pullback',
    blurb: 'Trade with the trend — wait for a pullback into a moving average, then join the move.',
    tags: {
      setups: ['EMA Pullback', 'Trend Continuation'],
      confluences: ['VWAP'],
      entry_model: ['Limit at AOI'],
    },
  },
  {
    key: 'break-retest',
    name: 'Break & Retest',
    blurb: 'Let price break a key level, wait for it to re-test as support/resistance, then enter with the break.',
    tags: {
      setups: ['Break & Retest'],
      confluences: ['PDH/PDL'],
      entry_model: ['Limit at AOI'],
    },
  },
]

/** Sane starting rules shared by every starter — matches RulesStep "Use recommended". */
export const STARTER_DEFAULT_RULES = {
  risk_per_trade: { mode: 'R', value: 1 },
  stop: { mode: 'atr', value: 1 },
  tp: '2R (scaling allowed)',
  rails: {
    daily_loss_limit: null,
    max_size: null,
    max_trades: 7,
    cooldown_min: 2,
    no_add_to_loser: true,
  },
} as const
