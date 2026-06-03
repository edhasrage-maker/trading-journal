/**
 * Tradezella CSV → historical_trades normalizer (pure, no DB).
 *
 * Maps Tradezella's columns onto our 7 tag categories, normalizes the messy
 * free-text tag values, and matches them to existing tags where they clearly
 * correspond (case/punctuation-insensitive) — adding the rest as new tags.
 * Produces records shaped for the historical_trades table.
 */

export type TagCategory =
  | 'setups' | 'confluences' | 'order_flow' | 'trade_management' | 'day_type' | 'mistakes' | 'emotions'

export type TZRow = Record<string, string>

// Tradezella column → our category (see the mapping table shared with the user).
const CATEGORY_MAP: Array<{ col: string; cat: TagCategory }> = [
  { col: 'Setups', cat: 'setups' },
  { col: 'Playbook', cat: 'setups' },
  { col: 'Orderflow', cat: 'order_flow' },
  { col: 'Entry Model', cat: 'order_flow' },
  { col: 'Custom Tags', cat: 'confluences' },
  { col: 'Trade Management', cat: 'trade_management' },
  { col: 'Day Type', cat: 'day_type' },
  { col: 'Mistakes', cat: 'mistakes' },
  { col: 'Emotion', cat: 'emotions' },
]

export const TAG_CATEGORIES: TagCategory[] =
  ['setups', 'confluences', 'order_flow', 'trade_management', 'day_type', 'mistakes', 'emotions']

/** Match key: lowercase, strip non-alphanumerics. "IB Hold" == "ib hold" == "ib-hold".
 *  Note: `&` and `and` both collapse to nothing-or-`and` here; `Break & Retest`
 *  and `Break And Retest` produce the same key, so the dedupe in the resolver
 *  picks up the existing library entry rather than creating a duplicate. */
export function tagKey(s: string): string {
  return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')
}

/**
 * Map legacy Tradezella emotion values onto the new 3-option vocabulary
 * (Stable / Compromised / MAXRAGE). Mirrors the SQL migration ran on
 * 2026-06-02. Applied to ANY raw emotion value coming through the importer
 * so a re-import won't reintroduce `Calm`, `Pissed Off_angry`, etc.
 *   Calm                                  → Stable
 *   Frustrated/Angry, Pissed Off_angry    → MAXRAGE
 *   Already-canonical values              → unchanged
 *   Anything else (Rushed, Anxious, etc.) → Compromised
 */
export function mapEmotionToCurrentVocab(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === 'Calm') return 'Stable'
  if (trimmed === 'Frustrated/Angry' || trimmed === 'Pissed Off_angry') return 'MAXRAGE'
  if (trimmed === 'Stable' || trimmed === 'Compromised' || trimmed === 'MAXRAGE') return trimmed
  return 'Compromised'
}

/** Pretty label for a NEW tag: collapse whitespace, Title Case words, keep punctuation. */
export function prettyLabel(s: string): string {
  return s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function splitTags(cell: string | undefined): string[] {
  if (!cell) return []
  return cell.split(',').map(s => s.trim()).filter(Boolean)
}

function num(v: string | undefined): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Parse "08:41:11 PST" + "2026-02-05" → ISO UTC. Falls back to null. */
function parseTzTime(dateStr: string | undefined, timeStr: string | undefined): string | null {
  if (!dateStr || !timeStr) return null
  const m = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})\s*([A-Z]{2,4})?/)
  if (!m) return null
  const [, hh, mm, ss, tz] = m
  const offset = tz === 'PDT' ? '-07:00' : tz === 'PST' ? '-08:00'
    : tz === 'EDT' ? '-04:00' : tz === 'EST' ? '-05:00'
    : tz === 'CDT' ? '-05:00' : tz === 'CST' ? '-06:00'
    : tz === 'UTC' ? 'Z' : 'Z'
  const d = new Date(`${dateStr.slice(0, 10)}T${hh.padStart(2, '0')}:${mm}:${ss}${offset}`)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export interface NormalizedHistoricalTrade {
  source: 'tradezella'
  account: string | null
  symbol: string | null
  side: 'long' | 'short' | null
  status: string | null
  open_at: string | null
  close_at: string | null
  trade_date: string | null
  entry_price: number | null
  exit_price: number | null
  quantity: number | null
  net_pnl: number | null
  gross_pnl: number | null
  net_roi: number | null
  realized_rr: number | null
  reward_ratio: number | null
  trade_risk: number | null
  position_mfe: number | null
  position_mae: number | null
  price_mfe: number | null
  price_mae: number | null
  duration_sec: number | null
  rating: number | null
  zella_score: number | null
  tags_json: Record<string, string[] | string>
  raw_json: TZRow
  dedup_key: string
}

export type TagLookup = Record<TagCategory, Map<string, string>>

export function emptyTagLookup(): TagLookup {
  return {
    setups: new Map(), confluences: new Map(), order_flow: new Map(),
    trade_management: new Map(), day_type: new Map(), mistakes: new Map(), emotions: new Map(),
  }
}

/**
 * Normalize one CSV row. `lookup` is seeded with existing tags (key→label) and
 * is MUTATED as new tags are discovered; each newly-created tag is also pushed
 * to `newTags` so the caller can persist it to trade_tags.
 */
export function normalizeRow(row: TZRow, lookup: TagLookup, newTags: Array<{ category: TagCategory; label: string }>): NormalizedHistoricalTrade {
  const resolve = (cat: TagCategory, raw: string): string => {
    // Emotion category: collapse legacy values onto the 3-option vocabulary
    // BEFORE library lookup so the user's redesigned library is canonical.
    const mapped = cat === 'emotions' ? mapEmotionToCurrentVocab(raw) : raw
    const k = tagKey(mapped)
    if (!k) return prettyLabel(mapped)
    const existing = lookup[cat].get(k)
    if (existing) return existing
    const label = prettyLabel(mapped)
    lookup[cat].set(k, label)
    newTags.push({ category: cat, label })
    return label
  }

  const tags: Record<string, string[] | string> = {}
  for (const { col, cat } of CATEGORY_MAP) {
    const vals = splitTags(row[col]).map(v => resolve(cat, v))
    if (vals.length === 0) continue
    if (cat === 'day_type') {
      if (!tags.day_type) tags.day_type = vals[0]
    } else {
      const prev = (tags[cat] as string[] | undefined) ?? []
      tags[cat] = Array.from(new Set([...prev, ...vals]))
    }
  }

  const sideRaw = (row['Side'] || '').toLowerCase()
  const side = sideRaw === 'short' ? 'short' : sideRaw === 'long' ? 'long' : null
  const tradeDate = (row['Open Date'] || '').slice(0, 10) || null

  const dedupBasis = [row['Open Date'], row['Open Time'], row['Symbol'], row['Entry Price'], row['Quantity'], row['Side'], row['Net P&L']].join('|')

  return {
    source: 'tradezella',
    account: row['Account Name'] || null,
    symbol: row['Symbol'] || row['Instrument'] || null,
    side,
    status: row['Status'] || null,
    open_at: parseTzTime(row['Open Date'], row['Open Time']),
    close_at: parseTzTime(row['Close Date'], row['Close Time']),
    trade_date: tradeDate,
    entry_price: num(row['Entry Price']),
    exit_price: num(row['Exit Price']),
    quantity: num(row['Quantity']),
    net_pnl: num(row['Net P&L']),
    gross_pnl: num(row['Gross P&L']),
    net_roi: num(row['Net ROI']),
    realized_rr: num(row['Realized RR']),
    reward_ratio: num(row['Reward Ratio']),
    trade_risk: num(row['Trade Risk']),
    position_mfe: num(row['Position MFE']),
    position_mae: num(row['Position MAE']),
    price_mfe: num(row['Price MFE']),
    price_mae: num(row['Price MAE']),
    duration_sec: num(row['Duration']),
    rating: num(row['Rating']),
    zella_score: num(row['Zella Score']),
    tags_json: tags,
    raw_json: row,
    dedup_key: 'tz:' + djb2(dedupBasis),
  }
}
