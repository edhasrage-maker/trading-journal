/**
 * High-impact ("red folder") economic news for the prep page.
 *
 * Source: Forex Factory's free weekly calendar XML (the literal red-folder
 * feed). No API key. The dev server runs locally (see CLAUDE.md) so it can
 * fetch this server-side with no CORS concern. Fetched in the prep server
 * component and passed to PrepClient — never blocks prep on a feed hiccup.
 *
 * TIMEZONE: the feed publishes times in UTC/GMT. We convert to America/
 * Los_Angeles (PT — the app convention) and America/New_York (ET — the news
 * convention, shown on hover) with Intl, so DST is handled correctly. We also
 * filter by the event's PT calendar date (not the feed's UTC date) so an event
 * lands on the right prep day even if the UTC→PT shift crosses midnight.
 */

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml'
// Currencies whose high-impact prints actually move NQ/MNQ. USD is the core;
// expand here if you want ECB/BOE etc. surfaced too.
const RELEVANT_COUNTRIES = new Set(['USD'])

export interface NewsEvent {
  title: string
  country: string
  /** PT display time, e.g. "6:00 AM". Null for All Day / Tentative. */
  timePt: string | null
  /** ET display time (news convention), shown on hover. Null for non-clock. */
  timeEt: string | null
  /** Minutes-since-midnight PT for sorting; null for All Day / Tentative. */
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
    // `next: { revalidate }` puts the response in Next's Data Cache, which is
    // SHARED across serverless instances — so a cold instance hits the cache
    // instead of doing a live XML fetch that blocks the page render. Timeout
    // trimmed 8s→3.5s so even a genuine cache miss can't hang the page long.
    const res = await fetch(FEED_URL, {
      signal: AbortSignal.timeout(3500),
      next: { revalidate: 3600 },
    })
    if (!res.ok) return cache?.xml ?? null
    const xml = await res.text()
    cache = { atMs: Date.now(), xml }
    return xml
  } catch {
    return cache?.xml ?? null
  }
}

const unwrap = (s: string | undefined): string =>
  (s ?? '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? unwrap(m[1]) : ''
}

function fmt12(h24: number, min: number): string {
  const ap = h24 < 12 ? 'AM' : 'PM'
  const h = ((h24 + 11) % 12) + 1
  return `${h}:${String(min).padStart(2, '0')} ${ap}`
}

/** Feed date (MM-DD-YYYY) + time (UTC "1:00pm", or "All Day"/"Tentative") →
 *  PT calendar date + PT/ET display strings, DST-correct via Intl. Non-clock
 *  times keep the feed calendar date and null times. */
function feedToPt(feedDateMdy: string, timeRaw: string): {
  ptDate: string; timePt: string | null; timeEt: string | null; sortKeyPt: number | null
} {
  const [mm, dd, yyyy] = feedDateMdy.split('-').map(Number)
  const m = timeRaw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
  if (!mm || !dd || !yyyy || !m) {
    const iso = mm && dd && yyyy
      ? `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
      : ''
    return { ptDate: iso, timePt: null, timeEt: null, sortKeyPt: null }
  }
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (h === 12) h = 0
  if (m[3].toLowerCase() === 'pm') h += 12
  const d = new Date(Date.UTC(yyyy, mm - 1, dd, h, min))
  const inZone = (tz: string) => {
    const p: Record<string, string> = {}
    for (const x of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)) p[x.type] = x.value
    const hh = p.hour === '24' ? 0 : parseInt(p.hour)
    return { date: `${p.year}-${p.month}-${p.day}`, mins: hh * 60 + parseInt(p.minute), label: fmt12(hh, parseInt(p.minute)) }
  }
  const pt = inZone('America/Los_Angeles')
  const et = inZone('America/New_York')
  return { ptDate: pt.date, timePt: pt.label, timeEt: et.label, sortKeyPt: pt.mins }
}

/**
 * High-impact events for one PT trading date (YYYY-MM-DD). Returns [] on any
 * feed problem so prep never breaks. Only covers dates in the current week
 * (the thisweek feed) — other dates return [].
 */
export async function fetchHighImpactNews(date: string): Promise<NewsEvent[]> {
  const xml = await fetchFeedXml()
  if (!xml) return []

  const out: NewsEvent[] = []
  for (const block of xml.split('<event>').slice(1)) {
    if (tag(block, 'impact') !== 'High') continue
    const country = tag(block, 'country')
    if (!RELEVANT_COUNTRIES.has(country)) continue
    const rawTime = tag(block, 'time')
    const conv = feedToPt(tag(block, 'date'), rawTime)
    if (conv.ptDate !== date) continue // filter by PT calendar date, not UTC
    out.push({
      title: tag(block, 'title'),
      country,
      timePt: conv.timePt,
      timeEt: conv.timeEt ?? (rawTime || 'All Day'),
      sortKeyPt: conv.sortKeyPt,
      url: tag(block, 'url'),
    })
  }
  // All-day / tentative first (null sortKey), then by PT time.
  out.sort((a, b) => (a.sortKeyPt ?? -1) - (b.sortKeyPt ?? -1))
  return out
}
