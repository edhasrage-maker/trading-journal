/**
 * High-impact ("red folder") economic news for the prep page.
 *
 * Source: Forex Factory's free weekly calendar XML (the literal red-folder
 * feed). No API key. The dev server runs locally (see CLAUDE.md) so it can
 * fetch this server-side with no CORS concern. Fetched in the prep server
 * component and passed to PrepClient — never blocks prep on a feed hiccup.
 *
 * TIMEZONE: the feed publishes times in US Eastern. The app displays America/
 * Los_Angeles. ET and PT both observe US DST and are ALWAYS exactly 3 hours
 * apart, so the conversion is a flat −3h (with day-rollover handling) — no DST
 * edge cases. We surface BOTH the ET and PT time so a feed-TZ surprise is
 * obvious on sight; flip FEED_TZ_OFFSET_FROM_PT if FF ever changes the feed TZ.
 */

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml'
// Hours to ADD to a feed (ET) time to get PT. ET is 3h ahead of PT, so −3.
const FEED_TZ_OFFSET_FROM_PT = -3
// Currencies whose high-impact prints actually move NQ/MNQ. USD is the core;
// expand here if you want ECB/BOE etc. surfaced too.
const RELEVANT_COUNTRIES = new Set(['USD'])

export interface NewsEvent {
  title: string
  country: string
  /** "8:30am" style original feed time (ET), or 'All Day' / 'Tentative'. */
  timeEt: string
  /** Converted display time in PT, e.g. "5:30 AM". Null for All Day/Tentative. */
  timePt: string | null
  /** Minutes-since-midnight PT for sorting; null for All Day/Tentative. */
  sortKeyPt: number | null
  url: string
}

// Module-level cache — the weekly XML changes only a few times a week, and
// faireconomy asks for ≤1 request/hour (else HTTP 429). Refetch at most hourly;
// on a 429/error we fall back to the last good copy so the banner persists.
let cache: { atMs: number; xml: string } | null = null
const CACHE_TTL_MS = 60 * 60 * 1000

async function fetchFeedXml(): Promise<string | null> {
  if (cache && Date.now() - cache.atMs < CACHE_TTL_MS) return cache.xml
  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return cache?.xml ?? null
    const xml = await res.text()
    cache = { atMs: Date.now(), xml }
    return xml
  } catch {
    // Feed down / timeout — fall back to a stale cache if we have one, else
    // null. Either way prep renders; it just shows no news banner.
    return cache?.xml ?? null
  }
}

const unwrap = (s: string | undefined): string =>
  (s ?? '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? unwrap(m[1]) : ''
}

/** Parse "8:30am" (ET) → { pt: "5:30 AM", sortKey } shifted −3h, with day
 *  rollover. Returns nulls for non-clock times (All Day / Tentative). */
function etToPt(timeEt: string): { timePt: string | null; sortKeyPt: number | null } {
  const m = timeEt.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
  if (!m) return { timePt: null, sortKeyPt: null }
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const pm = m[3].toLowerCase() === 'pm'
  if (h === 12) h = 0
  if (pm) h += 12
  // shift ET → PT
  let ptMinutes = h * 60 + min + FEED_TZ_OFFSET_FROM_PT * 60
  ptMinutes = ((ptMinutes % 1440) + 1440) % 1440 // wrap into [0, 1440)
  const ph = Math.floor(ptMinutes / 60)
  const pmin = ptMinutes % 60
  const disp = `${((ph + 11) % 12) + 1}:${String(pmin).padStart(2, '0')} ${ph < 12 ? 'AM' : 'PM'}`
  return { timePt: disp, sortKeyPt: ptMinutes }
}

/**
 * High-impact events for one PT trading date (YYYY-MM-DD). Returns [] on any
 * feed problem so prep never breaks. Only covers dates in the current week
 * (the thisweek feed) — other dates return [].
 */
export async function fetchHighImpactNews(date: string): Promise<NewsEvent[]> {
  const xml = await fetchFeedXml()
  if (!xml) return []
  const [, mm, dd] = date.split('-') // YYYY-MM-DD
  if (!mm || !dd) return []
  const feedDate = `${mm}-${dd}-${date.slice(0, 4)}` // FF uses MM-DD-YYYY

  const out: NewsEvent[] = []
  for (const block of xml.split('<event>').slice(1)) {
    const impact = tag(block, 'impact')
    if (impact !== 'High') continue
    const country = tag(block, 'country')
    if (!RELEVANT_COUNTRIES.has(country)) continue
    if (tag(block, 'date') !== feedDate) continue
    const timeEt = tag(block, 'time') || 'All Day'
    const { timePt, sortKeyPt } = etToPt(timeEt)
    out.push({ title: tag(block, 'title'), country, timeEt, timePt, sortKeyPt, url: tag(block, 'url') })
  }
  // All-day / tentative first (null sortKey), then by PT time.
  out.sort((a, b) => (a.sortKeyPt ?? -1) - (b.sortKeyPt ?? -1))
  return out
}
