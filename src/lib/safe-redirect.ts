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

export function safeNextPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
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
