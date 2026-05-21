/**
 * Client-side helpers for managing blobs in Supabase Storage via /api/screenshots.
 */

/** Delete a single blob from a bucket by its public URL. Best-effort; doesn't throw. */
export async function deleteBlob(url: string | null | undefined, bucket = 'screenshots'): Promise<boolean> {
  if (!url || typeof url !== 'string') return false
  if (url.startsWith('blob:')) return false // local preview, nothing to delete
  try {
    const res = await fetch('/api/screenshots', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, bucket }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Delete multiple blobs in a single round-trip. Bucket is shared across all urls. */
export async function deleteBlobs(urls: (string | null | undefined)[], bucket = 'screenshots'): Promise<number> {
  const filtered = urls.filter((u): u is string =>
    typeof u === 'string' && u.length > 0 && !u.startsWith('blob:'),
  )
  if (filtered.length === 0) return 0
  try {
    const res = await fetch('/api/screenshots', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: filtered, bucket }),
    })
    if (!res.ok) return 0
    const data = await res.json() as { deleted?: number }
    return data.deleted ?? 0
  } catch {
    return 0
  }
}
