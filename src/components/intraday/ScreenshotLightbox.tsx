'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'

/**
 * Fullscreen zoom modal for trade screenshots. Shared by both the read-mode
 * view (IntradayClient) and the edit-mode form (TradeForm via PinPlacement).
 *
 * Image renders at natural resolution capped to the viewport via max-w/max-h
 * — very wide screenshots get letterboxed rather than cropped. Close via
 * backdrop click, the top-right X, or the Escape key. Clicks on the image
 * itself stop propagation so they don't dismiss.
 */
export default function ScreenshotLightbox({
  src,
  onClose,
}: {
  src: string | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, onClose])

  if (!src) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 cursor-zoom-out"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Trade screenshot zoom"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Trade screenshot (zoomed)"
        className="max-w-full max-h-full object-contain rounded shadow-2xl"
        onClick={e => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-gray-900/80 hover:bg-gray-800 text-gray-300 hover:text-white border border-gray-700 transition-colors"
        aria-label="Close zoom"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
