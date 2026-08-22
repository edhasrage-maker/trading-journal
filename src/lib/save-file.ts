/**
 * Hand a generated file to the user, on a phone as well as a desktop.
 *
 * The obvious markup — `<a download href="/api/...">` — is a desktop assumption.
 * iOS ignores the `download` attribute and treats the click as a navigation, so
 * what happens next is up to Safari: sometimes a silent save into Files with no
 * visible confirmation, sometimes the CSV rendered inline as text, and inside an
 * installed PWA (this app sets display:standalone) nothing at all, because a
 * standalone window has nowhere to put a download. In every one of those cases
 * the tap reads as broken.
 *
 * So on those platforms ask the OS for the file instead of navigating to it:
 * the Web Share sheet offers "Save to Files", which is explicit and impossible
 * to miss. Everywhere else an object URL and a synthetic click do what they
 * always did.
 *
 * WHICH path is chosen cannot be decided by capability alone. `canShare({files})`
 * is NOT a proxy for "this is a phone" — Chrome and Edge on Windows 11 implement
 * it too, so feature-detection sent every desktop export into the Windows share
 * sheet (Nearby Sharing, Teams, WhatsApp…) when the user asked for a file on
 * their disk. So the test below is "would a download actually work here", and
 * the share sheet is reserved for the cases where it wouldn't.
 */

/**
 * True only where `<a download>` can't be trusted to produce a saved file:
 *
 *   • iOS / iPadOS — Safari ignores the download attribute entirely, and every
 *     other iOS browser is Safari underneath. iPadOS reports itself as
 *     "MacIntel", so touch points are the only thing separating it from a Mac.
 *   • An installed PWA — a standalone window has no download shelf or bar for
 *     the file to land in, so the click can complete with nothing to show.
 *
 * Desktop browsers and Android Chrome both honour `download`, and a file saved
 * to Downloads is what the user asked for on both.
 */
function downloadIsUnreliable(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean; platform?: string }
  const ua = nav.userAgent || ''
  const isIOS = /iP(hone|ad|od)/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  if (isIOS) return true
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
}

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled'

/** Pull the server's own filename out of Content-Disposition, if it gave one. */
function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null
  // RFC 5987 form first (filename*=UTF-8''name.csv), then the plain quoted one.
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  if (encoded) { try { return decodeURIComponent(encoded) } catch { /* fall through */ } }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null
}

/**
 * Fetch `url` and give the result to the user as a file.
 *
 * Returns how it was delivered, or 'cancelled' when they dismissed the share
 * sheet — a cancel is a normal outcome, not an error, and must not surface as a
 * failure. Anything genuinely broken throws.
 */
export async function saveFileFromUrl(url: string, fallbackName: string): Promise<SaveOutcome> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Export failed (${res.status}). ${res.status === 401 ? 'Try signing in again.' : 'Please try again.'}`)
  }
  const blob = await res.blob()
  const name = filenameFrom(res.headers.get('content-disposition')) ?? fallbackName

  // Share only where a download wouldn't work, and only if this file can
  // actually be carried — canShare({files}) still has to pass, since some
  // browsers support share() for links but not attachments.
  const file = new File([blob], name, { type: blob.type || 'text/csv' })
  if (downloadIsUnreliable() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return 'shared'
    } catch (e) {
      // Dismissing the sheet is a cancel, and so is a second share starting
      // while one is open. Anything else (notably NotAllowedError, when the
      // await above outlived the tap's user gesture) falls through to the
      // download path rather than stranding the user with nothing.
      const err = e as { name?: string }
      if (err?.name === 'AbortError') return 'cancelled'
    }
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoke on the next turn — revoking synchronously can beat the click.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  }
  return 'downloaded'
}
