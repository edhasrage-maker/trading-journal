/**
 * Helpers for handing image content to the Anthropic API.
 *
 * The API accepts only four media types: image/jpeg, image/png, image/gif, image/webp.
 * Browsers sometimes report aliases like image/jpg or image/x-png, or an empty
 * string when the source has no detectable MIME — those need normalising before
 * we hand them off, otherwise the API returns a 400 invalid_request_error.
 */

export const ANTHROPIC_ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
export type AnthropicMediaType = typeof ANTHROPIC_ALLOWED_MEDIA_TYPES[number]

const ALIASES: Record<string, AnthropicMediaType> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-citrix-jpeg': 'image/jpeg',
  'image/x-citrix-png': 'image/png',
}

/**
 * Returns a normalised media type Anthropic accepts, or null if the input is
 * unsupported (e.g. image/svg+xml, image/heic, application/octet-stream).
 */
export function normalizeAnthropicMediaType(input: string | null | undefined): AnthropicMediaType | null {
  if (!input || typeof input !== 'string') return null
  const lower = input.trim().toLowerCase()
  if (!lower) return null
  if ((ANTHROPIC_ALLOWED_MEDIA_TYPES as readonly string[]).includes(lower)) {
    return lower as AnthropicMediaType
  }
  if (ALIASES[lower]) return ALIASES[lower]
  return null
}

/** The image type the bytes actually are (PNG / JPEG / GIF / WebP), or null.
 *  Trust this over a stored label or a guess: the API rejects a PNG sent as
 *  image/jpeg with a 400 (founder hit it on "Read my chart", 2026-11-03). */
export function sniffImageType(bytes: Uint8Array): AnthropicMediaType | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}
