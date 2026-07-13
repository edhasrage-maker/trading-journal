import { NextResponse } from 'next/server'

// Long-task telemetry sink (see src/lib/longtask-beacon.ts). Deliberately
// trivial: it just logs the beacon so a real user's main-thread hang on
// /analytics surfaces in the Vercel function logs, then returns 204. No DB,
// no auth (the payload is non-sensitive perf timing), no caching.
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    if (body && typeof body === 'object') {
      const { route, reason, count, longestMs, totalBlockingMs, meta, ua } = body as Record<string, unknown>
      console.warn('[longtask]', JSON.stringify({ route, reason, count, longestMs, totalBlockingMs, meta, ua }))
    }
  } catch { /* best-effort — never error on telemetry */ }
  // 204: sendBeacon ignores the body; keep it empty.
  return new NextResponse(null, { status: 204 })
}
