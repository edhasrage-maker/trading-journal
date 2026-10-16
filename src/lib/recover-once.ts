/**
 * One automatic reload when a page fails to render.
 *
 * The founder hit "This page couldn't load" on the first visit to the dashboard,
 * every time, and a manual reload always fixed it (2026-10-16). The usual cause
 * is a page left open across a deploy: the open tab still runs the previous
 * build, and navigating asks for script files that build had and the new one
 * doesn't (the production domain serves only the newest deploy's assets, and
 * several deploys land a day). A full reload pulls the new build. The error
 * boundaries do that reload once, automatically — and if the page fails again
 * straight after, they show the real error instead of looping.
 */

const KEY = 'tapescore-recovered-at'
/** A second failure within this window means the reload did not help. */
const WINDOW_MS = 60_000

/** Errors that mean "this tab's build is older than the server's". */
export function isStaleBuildError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null
  const text = `${e?.name ?? ''} ${e?.message ?? ''}`
  return /ChunkLoadError|Loading (CSS )?chunk|Failed to load chunk|dynamically imported module|Importing a module script failed|Unexpected token '<'/i.test(text)
}

/**
 * Reload the page unless we already did so in the last minute. Returns true
 * when a reload was started (the caller shows "loading" meanwhile).
 */
export function reloadOnce(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const last = Number(window.sessionStorage.getItem(KEY) ?? 0)
    if (Number.isFinite(last) && Date.now() - last < WINDOW_MS) return false
    window.sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    // Storage blocked (private mode): reload anyway, but only from a fresh
    // page — the marker on window stops a loop within this document.
    const w = window as unknown as { __tapescoreRecovered?: boolean }
    if (w.__tapescoreRecovered) return false
    w.__tapescoreRecovered = true
  }
  window.location.reload()
  return true
}
