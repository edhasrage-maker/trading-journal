/**
 * Where to send someone after sign-in, given a `next` value that arrived in a
 * URL — so it is attacker-controlled. Only a path on THIS site is accepted;
 * anything else falls back.
 *
 * The callback builds the redirect as `${origin}${next}`. Unchecked, `next`
 * could leave the site: "@evil.com" makes "https://tapescore.app@evil.com"
 * (evil.com, with "tapescore.app" as a username) and ".evil.com" makes
 * "https://tapescore.app.evil.com". Browsers also read "/\evil.com" and
 * "/<tab>/evil.com" as "//evil.com". So: a single leading "/", no
 * backslashes or control characters, and the result must still resolve to
 * our own origin.
 */
const PROBE_ORIGIN = 'https://tapescore.invalid'

/**
 * The page a signed-out visitor was trying to open, kept for an hour so that
 * signing in lands them back on it instead of the dashboard. A cookie rather
 * than a `next` on the sign-in link, so the link Supabase emails stays exactly
 * the callback address on its redirect allow-list. Set by src/proxy.ts; read
 * and cleared by the sign-in callback, or by the proxy when a signed-in user
 * arrives at `/` (the password sign-in path). Always re-checked with
 * safeNextPath before use.
 */
export const RETURN_TO_COOKIE = 'ts_return_to'
export const RETURN_TO_COOKIE_OPTIONS = {
  path: '/',
  maxAge: 60 * 60,
  sameSite: 'lax' as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
}

export function safeNextPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback
  let url: URL
  try {
    url = new URL(raw, PROBE_ORIGIN)
  } catch {
    return fallback
  }
  if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith('//')) return fallback
  return `${url.pathname}${url.search}${url.hash}`
}
