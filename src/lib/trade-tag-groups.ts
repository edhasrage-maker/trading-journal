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

/** The groups in order with their tags_json keys — for the views that edit them (Replay Review's Your trade). */
export const TRADE_TAG_CATS: ReadonlyArray<{ key: string; label: string; danger?: boolean }> = TAG_CATS

/** One group's tags from tags_json: its strings, empty ones dropped. */
export function tagsOf(tags: unknown, key: string): string[] {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return []
  const v = (tags as Record<string, unknown>)[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

export function tradeTagGroups(tags: unknown): TagGroup[] {
  return TAG_CATS
    .map(c => ({ label: c.label, danger: c.danger, items: tagsOf(tags, c.key) }))
    .filter(g => g.items.length > 0)
}
