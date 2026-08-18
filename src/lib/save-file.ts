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
 * So ask the platform for the file instead of navigating to it. Where the Web
 * Share API can carry files — iOS Safari, Android Chrome — that opens the share
 * sheet with "Save to Files", which is explicit and impossible to miss. Where it
 * can't, an object URL and a synthetic click do what they always did.
 */

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

  // Feature-detect with the actual file: canShare({files}) is false on desktop
  // Chrome and on browsers that support share() for links but not attachments.
  const file = new File([blob], name, { type: blob.type || 'text/csv' })
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
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
