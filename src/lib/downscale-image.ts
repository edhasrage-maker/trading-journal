/**
 * Client-side downscale for screenshots headed to a vision route.
 *
 * A full-screen Sierra capture off a super-ultrawide monitor is a multi-MB PNG,
 * and that trips hard limits the user never sees: the vision API rejects images
 * over ~5 MB / 8000 px, and the deployed platform caps request bodies around
 * 4.5 MB — either way the trader just gets "Read failed". The model also
 * downsamples anything past ~2576 px on the long edge before reading it, so
 * pixels beyond that are pure risk with zero accuracy gain.
 *
 * Best-effort: any failure returns the original blob and the server guards
 * remain the backstop.
 */

/** The vision model's high-res cap on the long edge — larger is downsampled
 *  server-side anyway. */
export const VISION_MAX_EDGE = 2576
/** Recompress when the file alone approaches the deploy platform's ~4.5 MB
 *  body cap (leave headroom for multipart overhead). */
const MAX_BYTES = 3_500_000

export async function downscaleForVision(file: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file)
    try {
      const long = Math.max(bmp.width, bmp.height)
      const needsResize = long > VISION_MAX_EDGE
      const needsRecompress = file.size > MAX_BYTES
      if (!needsResize && !needsRecompress) return file
      const scale = needsResize ? VISION_MAX_EDGE / long : 1
      const w = Math.max(1, Math.round(bmp.width * scale))
      const h = Math.max(1, Math.round(bmp.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bmp, 0, 0, w, h)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
      // Only swap when it actually helped — a small already-JPEG can re-encode larger.
      return blob && blob.size < file.size ? blob : file
    } finally {
      bmp.close()
    }
  } catch {
    return file
  }
}
