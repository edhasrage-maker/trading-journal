/**
 * Screenshot storage URL resolver (public-build storage hardening).
 *
 * The public TapeScore project's `screenshots` bucket is PRIVATE + folder-RLS
 * scoped (`{auth.uid()}/...`), so objects are NOT world-readable by URL. New
 * uploads therefore store a bare STORAGE PATH in the DB (e.g.
 * `<uid>/trades/2026-07-03-....jpg`) instead of a public URL. This module signs
 * those paths at the SERVER read boundary so the browser receives a short-lived
 * signed URL it can render.
 *
 * Backward/compat rules (this must never break the local owner build, whose
 * personal `screenshots` bucket is still PUBLIC and whose rows hold absolute
 * `http(s)` public URLs — see CLAUDE.md / never-touch-live-site):
 *   - value is null/empty  → return as-is.
 *   - value starts http(s) → PASSTHROUGH (legacy public URL, cross-project URL,
 *     or an already-signed absolute URL). The local build persists public URLs,
 *     so this path keeps it byte-for-byte unchanged.
 *   - otherwise            → treat as a storage path in `screenshots` and mint a
 *     signed URL. On any error, fall back to the raw value rather than throwing
 *     (a single unreadable object must not 500 an entire EOD/prep page).
 *
 * All rendered screenshots (trade `screenshot_url`, day `chart_screenshot_url`
 * and `eod_chart_screenshot_url`) live in the ONE `screenshots` bucket. The
 * `sc-logs` bucket holds raw archives that are never rendered, so it needs no
 * read-boundary signing.
 */

export const SCREENSHOTS_BUCKET = 'screenshots'

/** Signed-URL lifetime. 24h comfortably outlives a page/session view without
 *  minting effectively-permanent links. */
export const SIGNED_URL_TTL_SEC = 60 * 60 * 24

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StorageClient = any

/** True when `value` is an absolute URL we should return untouched. */
function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/**
 * Resolve a single stored screenshot value to something the browser can load.
 * Absolute URLs pass through; storage paths are signed. Defensive: returns the
 * raw value on any signing failure.
 */
export async function resolveScreenshotUrl(
  supabase: StorageClient,
  value: string | null | undefined,
): Promise<string | null> {
  if (!value) return value ?? null
  if (isAbsoluteUrl(value)) return value
  try {
    const { data, error } = await supabase.storage
      .from(SCREENSHOTS_BUCKET)
      .createSignedUrl(value, SIGNED_URL_TTL_SEC)
    if (error || !data?.signedUrl) return value
    return data.signedUrl as string
  } catch {
    return value
  }
}

/**
 * Batch-resolve many screenshot values in as few round-trips as possible: all
 * storage paths are signed in one `createSignedUrls` call; absolute URLs and
 * empties are returned unchanged. Preserves input order; returns a value for
 * every input index.
 */
export async function resolveScreenshotUrls(
  supabase: StorageClient,
  values: Array<string | null | undefined>,
): Promise<Array<string | null>> {
  const out: Array<string | null> = values.map(v => (v ?? null))
  // Collect the path-typed values that actually need signing, with their index.
  const toSign: Array<{ idx: number; path: string }> = []
  values.forEach((v, idx) => {
    if (v && !isAbsoluteUrl(v)) toSign.push({ idx, path: v })
  })
  if (toSign.length === 0) return out
  try {
    const { data, error } = await supabase.storage
      .from(SCREENSHOTS_BUCKET)
      .createSignedUrls(toSign.map(t => t.path), SIGNED_URL_TTL_SEC)
    if (error || !Array.isArray(data)) return out
    // createSignedUrls returns results in the same order as the input paths.
    data.forEach((r: { signedUrl?: string | null; error?: string | null }, i: number) => {
      const target = toSign[i]
      if (target && r?.signedUrl) out[target.idx] = r.signedUrl
    })
    return out
  } catch {
    return out
  }
}

/**
 * Resolve `screenshot_url` in-place across a list of trade rows (single batched
 * sign). Returns the same array reference for convenience. No-ops on rows
 * without a screenshot.
 */
export async function signTradeScreenshots<T extends { screenshot_url?: string | null }>(
  supabase: StorageClient,
  trades: T[],
): Promise<T[]> {
  if (!trades || trades.length === 0) return trades
  const resolved = await resolveScreenshotUrls(supabase, trades.map(t => t.screenshot_url))
  trades.forEach((t, i) => { t.screenshot_url = resolved[i] })
  return trades
}

/** Resolve `screenshot_url` on a single trade row (if present). */
export async function signTradeScreenshot<T extends { screenshot_url?: string | null }>(
  supabase: StorageClient,
  trade: T | null,
): Promise<T | null> {
  if (!trade) return trade
  trade.screenshot_url = await resolveScreenshotUrl(supabase, trade.screenshot_url)
  return trade
}

/**
 * Resolve a day's two chart-screenshot fields in-place (single batched sign).
 * Returns the same object reference. No-ops on a null day.
 */
export async function signDayScreenshots<
  T extends { chart_screenshot_url?: string | null; eod_chart_screenshot_url?: string | null },
>(supabase: StorageClient, day: T | null): Promise<T | null> {
  if (!day) return day
  const [chart, eod] = await resolveScreenshotUrls(supabase, [
    day.chart_screenshot_url,
    day.eod_chart_screenshot_url,
  ])
  day.chart_screenshot_url = chart
  day.eod_chart_screenshot_url = eod
  return day
}

/**
 * Canonicalise a client-supplied screenshot value into what should be PERSISTED
 * on the hosted private build. The client only ever holds a signed URL (the read
 * boundary signs paths on the way out) and echoes that same field back on
 * unrelated saves — persisting the temporary signed URL would rot to a broken
 * image after the TTL. So on write we convert any of our-bucket signed/public
 * URLs back to their stable storage path:
 *   - our-bucket signed/public URL → the bare storage path.
 *   - bare storage path            → unchanged.
 *   - foreign absolute URL         → unchanged (legacy cross-project links).
 *   - null/empty                   → null.
 *
 * ONLY call this on the hosted build. The local owner build persists public URLs
 * against its PUBLIC bucket and must stay byte-for-byte unchanged; de-pathing
 * there would needlessly alter the daily-use app.
 */
export function normalizeStoredScreenshot(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  return screenshotStoragePath(value) ?? value
}

/**
 * Given a stored screenshot value (storage path, signed URL, or legacy public
 * URL), recover the underlying storage path inside the `screenshots` bucket so
 * it can be passed to `storage.remove()`. Returns null when the value doesn't
 * belong to this bucket (e.g. a cross-project absolute URL) — callers treat
 * that as "nothing to delete here".
 */
export function screenshotStoragePath(value: string | null | undefined): string | null {
  if (!value) return null
  // Legacy public URL:   .../storage/v1/object/public/screenshots/<path>
  // Signed URL:          .../storage/v1/object/sign/screenshots/<path>?token=...
  for (const marker of [
    `/storage/v1/object/public/${SCREENSHOTS_BUCKET}/`,
    `/storage/v1/object/sign/${SCREENSHOTS_BUCKET}/`,
  ]) {
    const idx = value.indexOf(marker)
    if (idx !== -1) {
      return decodeURIComponent(value.slice(idx + marker.length).split('?')[0])
    }
  }
  // An absolute URL that isn't a screenshots-bucket object → not ours to delete.
  if (isAbsoluteUrl(value)) return null
  // Otherwise it's already a bare storage path.
  return value
}
