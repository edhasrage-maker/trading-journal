/**
 * tags_json → display groups, in the order every trade view shows them (Game
 * film's zoomed screenshot, Replay Review's "Your trade" panel, the shared
 * session and the trade table), so one trade reads identically wherever you
 * meet it. Mistakes carry `danger` because they are the one group you want to
 * see before the others.
 */
export interface TagGroup { label: string; items: string[]; danger?: boolean }

const TAG_CATS: Array<{ key: string; label: string; danger?: boolean }> = [
  { key: 'setups', label: 'Setup' },
  { key: 'confluences', label: 'Confluence' },
  { key: 'order_flow', label: 'Order flow' },
  { key: 'entry_model', label: 'Entry' },
  { key: 'trade_management', label: 'Management' },
  { key: 'emotions', label: 'Emotion' },
  { key: 'mistakes', label: 'Mistake', danger: true },
]

export function tradeTagGroups(tags: unknown): TagGroup[] {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return []
  const t = tags as Record<string, unknown>
  return TAG_CATS
    .map(c => ({
      label: c.label,
      danger: c.danger,
      items: Array.isArray(t[c.key]) ? (t[c.key] as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '') : [],
    }))
    .filter(g => g.items.length > 0)
}
