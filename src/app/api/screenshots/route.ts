import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const formData = await req.formData()
  const file = formData.get('file') as File
  const bucket = (formData.get('bucket') as string) || 'screenshots'
  const path = formData.get('path') as string

  if (!file || !path) {
    return NextResponse.json({ error: 'Missing file or path' }, { status: 400 })
  }

  const buffer = await file.arrayBuffer()
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType: file.type, upsert: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(path)
  return NextResponse.json({ url: publicUrl })
}

/**
 * Delete one or more files from Supabase Storage.
 * Body: { url?, urls?, path?, paths?, bucket? }
 *   - `url` / `urls`: public URL(s); the route extracts the storage path.
 *   - `path` / `paths`: storage paths directly (e.g. for buckets you've
 *     listed via supabase.storage.list()).
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

  // Extract storage path from each public URL.
  // Supabase public URLs look like:
  //   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
  const marker = `/storage/v1/object/public/${bucket}/`
  for (const u of urls) {
    if (typeof u !== 'string' || !u) continue
    const idx = u.indexOf(marker)
    if (idx === -1) continue // not a public URL for this bucket
    paths.push(decodeURIComponent(u.slice(idx + marker.length).split('?')[0]))
  }

  if (paths.length === 0) {
    return NextResponse.json({ deleted: 0, skipped: urls.length })
  }

  const { error } = await supabase.storage.from(bucket).remove(paths)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: paths.length })
}
