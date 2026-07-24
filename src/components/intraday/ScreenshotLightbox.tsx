'use client'

import { useEffect, useState, useRef } from 'react'
import { X, ZoomIn, ZoomOut } from 'lucide-react'

/**
 * Fullscreen zoom modal for trade screenshots. Shared by both the read-mode
 * view (IntradayClient) and the edit-mode form (TradeForm via PinPlacement).
 *
 * Three zoom levels, sized off the image's OWN pixels rather than the viewport:
 *   0 — Fit to viewport (object-contain, default)
 *   1 — 100%: one image pixel to one screen pixel — the sharpest possible read,
 *       and the level that actually makes Sierra's small text legible
 *   2 — 200%: magnified past native; bigger but interpolated
 *
 * Earlier levels were viewport multiples (200vw / 300vw), so on a typical
 * ~1920px capture even "2×" already overshot the source resolution and every
 * zoomed view looked soft. Anchoring to naturalWidth gives an honest 100% stop
 * and makes the labels mean what they say.
 *
 * Click the image to cycle 0 → 1 → 2 → 0. When zoomed in (>0) the outer
 * container becomes scrollable so the trader can pan around the chart by
 * scrolling. + / − buttons in the corner step zoom up/down explicitly.
 *
 * Close via backdrop click (outside the image), the X button, or Escape.
 * Clicks on the image are intentionally NOT close — they cycle zoom.
 */
export default function ScreenshotLightbox({
  src,
  onClose,
}: {
  src: string | null
  onClose: () => void
}) {
  // Zoom level cycles 0 (fit) → 1 (100%) → 2 (200%) → 0. Reset whenever a new
  // src arrives so opening another screenshot starts from fit.
  const [zoom, setZoom] = useState(0)
  // The image's intrinsic pixel size, read on load. Levels 1 and 2 are computed
  // from this, so "100%" is a true 1:1 pixel mapping rather than a viewport
  // multiple that may or may not exceed the source resolution.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Drag-to-pan state. While dragging, scroll position follows the cursor.
  // dragStart captures the initial mouse + scroll position; movedRef tracks
  // whether the cursor moved beyond a small threshold so the mouseup can
  // distinguish a click (→ cycle zoom) from a drag (→ no zoom change).
  const isDraggingRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const movedRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset zoom when a NEW screenshot opens so each modal starts at Fit
    setZoom(0)
    // Drop the previous image's intrinsic size; the new one reports its own on load.
    setNatural(null)
  }, [src])

  // Auto-center the scroll position whenever zoom changes. Without this,
  // the browser tends to anchor the scroll at one edge (Chrome on Windows
  // pins to the right edge, giving the "can only drag right" symptom).
  // Centering on zoom-in puts equal scroll room on every side so drag-to-
  // pan works symmetrically.
  useEffect(() => {
    if (!scrollRef.current || zoom === 0) return
    // Use rAF so the layout has settled after the size change before we
    // read scrollWidth / scrollHeight (otherwise we'd center against the
    // PREVIOUS zoom level's measurements).
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
    })
    return () => cancelAnimationFrame(id)
  }, [zoom, src])

  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === '+' || e.key === '=') setZoom(z => Math.min(2, z + 1))
      else if (e.key === '-' || e.key === '_') setZoom(z => Math.max(0, z - 1))
      else if (e.key === '0') setZoom(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, onClose])

  // Window-level mouse listeners so dragging keeps tracking even when the
  // cursor leaves the image (a common UX issue with element-only handlers).
  useEffect(() => {
    if (!src) return
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current || !scrollRef.current) return
      const { x, y, sl, st } = dragStartRef.current
      const dx = e.clientX - x
      const dy = e.clientY - y
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) movedRef.current = true
      scrollRef.current.scrollLeft = sl - dx
      scrollRef.current.scrollTop = st - dy
    }
    const onUp = () => {
      isDraggingRef.current = false
      setIsDragging(false)
      // Don't clear movedRef here — the image's onClick checks it
      // synchronously, then the next mousedown resets it.
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [src])

  if (!src) return null

  // Cycle: 0 (fit) → 1 (100%) → 2 (200%) → 0
  const cycleZoom = () => setZoom(z => (z >= 2 ? 0 : z + 1))

  // Displayed size at levels 1/2 — derived from the image's own pixels, so
  // level 1 is a true 1:1 mapping. Null until the image reports naturalWidth
  // (and at Fit), in which case we fall back to the object-contain path.
  const displayW = zoom > 0 && natural ? natural.w * zoom : null
  const displayH = zoom > 0 && natural ? natural.h * zoom : null
  const sized = displayW != null && displayH != null

  // The wrapper div takes an EXPLICIT size so the outer `overflow-auto`
  // container has a real, scrollable child. Earlier approach used a min-w-full
  // flex wrapper with an oversized image overflowing via justify-center — but
  // `overflow-auto` ignores flex children that overflow their parent via center
  // justification, so scrollLeft had no real range and pan only worked in one
  // direction. Sizing the wrapper to max(container, image) keeps the image
  // centered when it's smaller AND gives the scroll container a child larger
  // than itself when it's bigger, so bi-directional pan still works.
  const wrapperStyle: React.CSSProperties = sized
    ? { width: `max(100%, ${displayW}px)`, height: `max(100%, ${displayH}px)` }
    : { width: '100%', height: '100%' }
  // Cursor reflects state: actively dragging > grabbable (zoomed in) > zoom-in.
  const cursorClass = isDragging
    ? 'cursor-grabbing'
    : zoom > 0
      ? 'cursor-grab'
      : 'cursor-zoom-in'

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Trade screenshot zoom"
    >
      {/* Scrollable container — when zoomed in, this scrolls. The INNER
          wrapper is sized to at least the viewport so the image is centered
          when smaller, and grows when the image overflows so scrollLeft has
          equal room on both sides (the previous flex-direct-on-scrollroot
          pattern silently gave only one-direction pan in Chrome/Firefox).
          Click on the empty area (backdrop) closes; the image's own click
          cycles zoom. */}
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-auto cursor-zoom-out"
        onClick={onClose}
      >
        <div className="flex items-center justify-center p-2" style={wrapperStyle}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Trade screenshot (zoomed)"
          draggable={false}
          onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={sized ? { width: displayW!, height: displayH!, maxWidth: 'none', maxHeight: 'none' } : undefined}
          className={`${sized ? '' : 'max-w-full max-h-full w-full h-full object-contain'} rounded shadow-2xl ${cursorClass} select-none`}
          onMouseDown={e => {
            // Begin a drag session. Only "consumes" the click if it
            // actually pans — see movedRef logic in onClick below.
            if (!scrollRef.current) return
            isDraggingRef.current = true
            movedRef.current = false
            dragStartRef.current = {
              x: e.clientX, y: e.clientY,
              sl: scrollRef.current.scrollLeft,
              st: scrollRef.current.scrollTop,
            }
            setIsDragging(true)
            // Don't preventDefault — browsers handle img drag via the
            // draggable=false attribute, and we still want the click to fire.
          }}
          onClick={e => {
            e.stopPropagation()
            // If the cursor moved more than the drag threshold, this was
            // a pan, not a click — don't cycle zoom.
            if (movedRef.current) {
              movedRef.current = false
              return
            }
            cycleZoom()
          }}
        />
        </div>
      </div>

      {/* Top-right controls — zoom level indicator, +/-, and close. */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        <div className="bg-gray-900/90 border border-gray-700 rounded-full px-3 h-9 flex items-center gap-2 shadow-lg">
          <button
            type="button"
            onClick={() => setZoom(z => Math.max(0, z - 1))}
            disabled={zoom === 0}
            className="text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed"
            aria-label="Zoom out"
            title="Zoom out (-)"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span
            className="text-xs font-mono text-gray-300 select-none tabular-nums"
            title={zoom === 1 ? 'Actual size — one image pixel per screen pixel' : undefined}
          >
            {zoom === 0 ? 'Fit' : `${zoom * 100}%`}
          </span>
          <button
            type="button"
            onClick={() => setZoom(z => Math.min(2, z + 1))}
            disabled={zoom === 2}
            className="text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed"
            aria-label="Zoom in"
            title="Zoom in (+)"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-900/90 hover:bg-gray-800 text-gray-300 hover:text-white border border-gray-700 transition-colors shadow-lg"
          aria-label="Close zoom"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Hint changes contextually — keystroke reference plus drag hint
          when zoomed in (where the panning capability is non-obvious). */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-gray-500 font-mono pointer-events-none bg-gray-900/60 rounded px-2 py-1">
        {zoom === 0
          ? 'click image for 100% · + / − keys · esc to close'
          : zoom === 1
            ? 'actual size · click to magnify · drag to pan · esc to close'
            : 'past actual size · click for fit · drag to pan · esc to close'}
      </div>
    </div>
  )
}
