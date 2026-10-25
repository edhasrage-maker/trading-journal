import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { SIGNED_URL_TTL_SEC, screenshotStoragePath } from '@/lib/storage-url'
import { NextResponse } from 'next/server'

/**
 * Sanitize a client-supplied sub-path into safe path segments. Drops empty,
 * `.`/`..`, and any absolute/backslash trickery so the caller can only ever
 * write UNDER the folder we choose (their own `auth.uid()/`). Preserves the
 * intended subfolder (e.g. `trades/…`, `chart/…`, `chart-eod/…`).
 */
function safeSubPath(input: string): string {
  return input
    .replace(/\\/g, '/')
    .split('/')
    .map(s => s.trim())
    .filter(s => s !== '' && s !== '.' && s !== '..')
    .join('/')
}

/** Hosted uploads are trade and chart screenshots — images only, under the
 *  platform's ~4.5 MB request cap, into the one screenshots bucket. */
const HOSTED_UPLOAD_BUCKET = 'screenshots'
const HOSTED_UPLOAD_MAX_BYTES = 4_500_000

/** The image type the bytes actually are (PNG / JPEG / GIF / WebP), or null.
 *  The stored Content-Type comes from this check, never from the client's
 *  claim — a file labelled image/png must really start like one. */
function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const formData = await req.formData()
  const file = formData.get('file') as File
  const bucket = (formData.get('bucket') as string) || 'screenshots'
  const clientPath = formData.get('path') as string

  if (!file || !clientPath) {
    return NextResponse.json({ error: 'Missing file or path' }, { status: 400 })
  }

  const buffer = await file.arrayBuffer()

  // ── LOCAL OWNER BUILD ──────────────────────────────────────────────────────
  // The personal `screenshots` bucket is PUBLIC. Preserve the exact historical
  // behaviour (client-supplied path, public URL) so the daily-use app is
  // untouched. `path` mirrors `url` (a public URL) so the shared client code
  // can uniformly persist `data.path` — here that's just the public URL.
  if (LOCAL_FEATURES_ENABLED) {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(clientPath, buffer, { contentType: file.type, upsert: true })
    if (error) return NextResponse.json({ error: clientError(error) }, { status: 500 })
    const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(clientPath)
    return NextResponse.json({ url: publicUrl, path: publicUrl })
  }

  // ── HOSTED PUBLIC BUILD ────────────────────────────────────────────────────
  // Private buckets + per-user folders. Ignore the client path prefix and write
  // UNDER the server-derived `auth.uid()/` so a caller can never place an object
  // in another user's folder (folder-scoped storage RLS enforces this too).
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  if (bucket !== HOSTED_UPLOAD_BUCKET) {
    return NextResponse.json({ error: 'Unknown upload destination.' }, { status: 400 })
  }
  if (buffer.byteLength > HOSTED_UPLOAD_MAX_BYTES) {
    return NextResponse.json({ error: 'That image is over 4.5 MB — try a smaller screenshot.' }, { status: 413 })
  }
  const contentType = sniffImageType(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16)))
  if (!contentType) {
    return NextResponse.json({ error: 'Only PNG, JPEG, GIF or WebP images can be uploaded.' }, { status: 415 })
  }

  const sub = safeSubPath(clientPath)
  if (!sub) return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  const path = `${user.id}/${sub}`

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType, upsert: true })
  if (error) return NextResponse.json({ error: clientError(error) }, { status: 500 })

  // Persist the bare PATH (`data.path`); the read boundary signs it on the way
  // back out. Return a freshly-signed URL too for the client's optimistic
  // render right after upload (before the row round-trips through a read route).
  const { data: signed } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC)
  return NextResponse.json({ url: signed?.signedUrl ?? path, path })
}

/**
 * Delete one or more files from Supabase Storage.
 * Body: { url?, urls?, path?, paths?, bucket? }
 *   - `url` / `urls`: a stored screenshot value (storage path, signed URL, or
 *     legacy public URL); the route recovers the storage path from each.
 *   - `path` / `paths`: storage paths directly.
 *   - `bucket` defaults to 'screenshots'.
 *   - Missing files are silently ignored (idempotent).
 */
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const body = await req.json().catch(() => ({})) as {
    url?: string
    urls?: string[]
    path?: string
    paths?: string[]
    bucket?: string
  }
  const bucket = body.bucket || 'screenshots'
  const urls = body.urls ?? (body.url ? [body.url] : [])
  const paths = [...(body.paths ?? (body.path ? [body.path] : []))]

  // Recover a storage path from each stored value. Handles bare paths, signed
  // URLs (`/object/sign/<bucket>/`), and legacy public URLs
  // (`/object/public/<bucket>/`). Values that aren't in this bucket (e.g. a
  // cross-project absolute URL) yield null and are skipped.
  let skipped = 0
  for (const u of urls) {
    if (typeof u !== 'string' || !u) { skipped++; continue }
    const p = bucket === 'screenshots'
      ? screenshotStoragePath(u)
      : storagePathForBucket(u, bucket)
    if (p) paths.push(p)
    else skipped++
  }

  if (paths.length === 0) {
    return NextResponse.json({ deleted: 0, skipped })
  }

  const { error } = await supabase.storage.from(bucket).remove(paths)
  if (error) return NextResponse.json({ error: clientError(error) }, { status: 500 })
  return NextResponse.json({ deleted: paths.length, skipped })
}

/** Generic path recovery for a non-screenshots bucket (parallels
 *  screenshotStoragePath but parameterised on bucket name). */
function storagePathForBucket(value: string, bucket: string): string | null {
  for (const marker of [
    `/storage/v1/object/public/${bucket}/`,
    `/storage/v1/object/sign/${bucket}/`,
  ]) {
    const idx = value.indexOf(marker)
    if (idx !== -1) return decodeURIComponent(value.slice(idx + marker.length).split('?')[0])
  }
  if (/^https?:\/\//i.test(value)) return null
  return value
}
