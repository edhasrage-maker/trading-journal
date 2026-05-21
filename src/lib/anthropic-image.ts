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
