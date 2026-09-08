'use client'

import { useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react'
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
/** Upper zoom bound, as a multiple of the image's own pixels. Past 4x these
 *  are just enlarged pixels — Sierra exports have no more detail to give. */
const MAX_SCALE = 4

export default function ScreenshotLightbox({
  src,
  onClose,
  meta,
  actions,
  zoomResetKey,
}: {
  src: string | null
  onClose: () => void
  /** Optional context strip pinned to the bottom-left — the trade's tags, say.
   *  Zooming in is exactly when you stop being able to see the row you opened
   *  it from, so the facts that frame the picture have to travel with it. It
   *  hides while dragging, never takes pointer events (so the backdrop still
   *  closes on click), and is simply absent when nothing is passed. */
  meta?: React.ReactNode
  /** Identifies the OPEN, not the picture. Zoom resets when this changes, so a
   *  caller that swaps `src` while the lightbox stays open — flipping between
   *  frames in a catalog — keeps the zoom level the reader chose, instead of
   *  dropping back to Fit on every flip and making them re-zoom each time.
   *  Left undefined it falls back to `src`, the original per-image behaviour. */
  zoomResetKey?: string | number
  /** Interactive controls pinned to the bottom — unlike `meta`, this DOES take
   *  pointer events and swallows its own clicks so the backdrop cannot close
   *  under them. The point is to label a trade at the magnification you spotted
   *  it, rather than closing the picture to reach the form. */
  actions?: React.ReactNode
}) {
  // Continuous scale, as a multiplier of the image's OWN pixels: 1 = 1:1.
  // `null` means Fit — the scale is then derived from the container, so it
  // stays correct through rotation and resize without being recomputed here.
  // Continuous rather than three stops because on a phone the whole job is
  // reading a delta ladder, and the right magnification for that is wherever
  // your fingers stop, not the nearest preset.
  const [scale, setScale] = useState<number | null>(null)
  // Container size, needed to know what "Fit" currently means.
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
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
  // Pinch session: finger distance and scale at the moment the second finger
  // landed, plus where to re-anchor the scroll once the new size is laid out.
  const pinchRef = useRef<{ d0: number; s0: number } | null>(null)
  const anchorRef = useRef<{ u: number; v: number; mx: number; my: number } | null>(null)
  // Set on any touch so the compatibility click iOS fires afterwards does not
  // also cycle the zoom — on touch, zoom belongs to pinch and double-tap.
  const touchedAtRef = useRef(0)
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  // The touch listeners are bound once per image, so they read the live scale,
  // fit and intrinsic size through refs rather than closing over stale values.
  const effScaleRef = useRef<number | null>(null)
  const fitScaleRef = useRef<number | null>(null)
  const naturalRef = useRef<{ w: number; h: number } | null>(null)

  // Derived above the effects because the pinch-anchor layout effect needs it,
  // and hooks cannot live below the `if (!src)` early return further down.
  // What "Fit" is worth right now. Below this there is nothing to gain — the
  // whole image is already on screen — so it doubles as the lower clamp.
  const fitScale = natural && box ? Math.min(box.w / natural.w, box.h / natural.h) : null
  const effScale = scale ?? fitScale
  const zoomed = fitScale != null && effScale != null && effScale > fitScale * 1.01
  // Mirrored for the touch listeners, which bind once per image and would
  // otherwise close over the values as they were when the image opened.
  useEffect(() => {
    effScaleRef.current = effScale
    fitScaleRef.current = fitScale
    naturalRef.current = natural
  })

  // Clamp to [Fit, MAX]; anything at or under Fit collapses to the Fit sentinel
  // so the indicator reads "Fit" and a rotation still re-derives it.
  const stepZoom = useCallback((factor: number) => {
    if (fitScale == null) return
    setScale(prev => {
      const next = (prev ?? fitScale) * factor
      return next <= fitScale * 1.01 ? null : Math.min(MAX_SCALE, next)
    })
  }, [fitScale])

  const resetKey = zoomResetKey ?? src
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset zoom when a NEW screenshot opens so each modal starts at Fit
    setScale(null)
  }, [resetKey])

  useEffect(() => {
    // Always drop the previous image's intrinsic size, even on a flip that
    // keeps the zoom level: displayW/H are computed from it, so a stale value
    // would size the incoming image to the outgoing one until it loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: the new image reports its own size on load
    setNatural(null)
  }, [src])

  // Auto-center the scroll position whenever zoom changes. Without this,
  // the browser tends to anchor the scroll at one edge (Chrome on Windows
  // pins to the right edge, giving the "can only drag right" symptom).
  // Centering on zoom-in puts equal scroll room on every side so drag-to-
  // pan works symmetrically.
  useEffect(() => {
    // Skip while a pinch is driving the scale — that path anchors the scroll to
    // the point between the fingers, and re-centering would fight it.
    if (!scrollRef.current || scale == null || pinchRef.current) return
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
  }, [scale, src])

  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === '+' || e.key === '=') stepZoom(1.4)
      else if (e.key === '-' || e.key === '_') stepZoom(1 / 1.4)
      else if (e.key === '0') setScale(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, onClose, stepZoom])

  // Measure the container so Fit can be derived rather than assumed. A
  // ResizeObserver rather than a one-off read: rotating the phone changes what
  // Fit means, and a stale value would leave the image mis-sized until the next
  // interaction.
  useEffect(() => {
    const el = scrollRef.current
    if (!src || !el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [src])

  // Touch: pinch to zoom, double-tap to toggle. Registered non-passive because
  // a two-finger move has to be preventDefault-ed — otherwise Safari zooms the
  // whole document behind this overlay, which is what made pinching look like
  // it did nothing at all. One finger is deliberately left alone so the native
  // scroll of the container keeps doing the panning.
  useEffect(() => {
    const el = scrollRef.current
    if (!src || !el) return
    const dist = (t: TouchList) => Math.hypot(
      t[0].clientX - t[1].clientX,
      t[0].clientY - t[1].clientY,
    )

    const onStart = (e: TouchEvent) => {
      touchedAtRef.current = Date.now()
      if (e.touches.length === 2) {
        pinchRef.current = { d0: dist(e.touches), s0: effScaleRef.current ?? 1 }
      }
    }

    const onMove = (e: TouchEvent) => {
      const p = pinchRef.current
      if (e.touches.length !== 2 || !p) return
      e.preventDefault()
      const nat = naturalRef.current
      const fit = fitScaleRef.current
      if (!nat || fit == null) return
      const next = Math.min(MAX_SCALE, Math.max(fit, p.s0 * (dist(e.touches) / p.d0)))
      // Keep the point between the fingers pinned. Without this the image
      // slides away from whatever you were trying to read.
      const r = el.getBoundingClientRect()
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top
      const cur = effScaleRef.current ?? fit
      anchorRef.current = {
        u: (el.scrollLeft + mx) / (nat.w * cur),
        v: (el.scrollTop + my) / (nat.h * cur),
        mx, my,
      }
      setScale(next <= fit * 1.01 ? null : next)
    }

    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current = null
      if (e.touches.length > 0 || e.changedTouches.length !== 1) return
      // Double-tap toggles between Fit and 2x Fit — the gesture muscle memory
      // expects from Photos, and the only way to zoom without two hands.
      const t = e.changedTouches[0]
      const now = Date.now()
      const prev = lastTapRef.current
      const near = prev && Math.hypot(t.clientX - prev.x, t.clientY - prev.y) < 32
      if (prev && near && now - prev.t < 300) {
        lastTapRef.current = null
        const fit = fitScaleRef.current
        if (fit == null) return
        const cur = effScaleRef.current ?? fit
        setScale(cur > fit * 1.01 ? null : Math.min(MAX_SCALE, fit * 2))
        return
      }
      lastTapRef.current = { t: now, x: t.clientX, y: t.clientY }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [src])

  // Re-anchor the scroll to the pinch midpoint once the new size is laid out.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = anchorRef.current
    anchorRef.current = null
    if (!el || !a || !natural || effScale == null) return
    el.scrollLeft = a.u * natural.w * effScale - a.mx
    el.scrollTop = a.v * natural.h * effScale - a.my
  }, [effScale, natural])

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

  // Mouse only: the familiar Fit → 100% → 200% → Fit cycle. On touch this is
  // suppressed, because there a tap that silently changed magnification would
  // fight the pinch the finger is already trained to use.
  const cycleZoom = () => {
    if (fitScale == null) return
    setScale(prev => (prev == null ? 1 : prev < 2 ? 2 : null))
  }

  // Displayed size — derived from the image's own pixels, so 1.0 is a true 1:1
  // mapping. Null until the image reports naturalWidth and the container has
  // been measured, in which case we fall back to the object-contain path.
  const displayW = natural && effScale != null ? natural.w * effScale : null
  const displayH = natural && effScale != null ? natural.h * effScale : null
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
    : zoomed
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
            // iOS fires a compatibility click after every tap. Cycling zoom on
            // it would double-fire against the double-tap handler and change
            // magnification out from under a finger that meant to pan.
            if (Date.now() - touchedAtRef.current < 700) return
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

      {(meta || actions) && (
        <div
          className="absolute left-0 right-0 bottom-0 px-3 pt-3 flex flex-col gap-2 items-stretch sm:items-start pointer-events-none"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          {meta && !isDragging && (
            <div className="bg-gray-900/90 border border-gray-700 rounded-lg px-3 py-2 shadow-lg sm:max-w-[70vw]">
              {meta}
            </div>
          )}
          {actions && (
            <div
              className="pointer-events-auto w-full bg-gray-900/95 border border-gray-700 rounded-lg px-3 py-2 shadow-lg"
              onClick={e => e.stopPropagation()}
            >
              {actions}
            </div>
          )}
        </div>
      )}

      {/* Top-right controls — zoom level indicator, +/-, and close. Offset by
          the safe-area inset: the layout draws under the notch (viewportFit
          cover), so a flat top-3 put the close button behind it on iPhone and
          left the browser Back gesture as the only way out. Targets are 44px
          on touch, the iOS minimum, and tighten to 36 on pointer devices. */}
      <div
        className="absolute right-3 flex items-center gap-2"
        style={{ top: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <div className="bg-gray-900/90 border border-gray-700 rounded-full px-3 h-11 sm:h-9 flex items-center gap-3 sm:gap-2 shadow-lg">
          <button
            type="button"
            onClick={() => stepZoom(1 / 1.4)}
            disabled={!zoomed}
            className="text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed"
            aria-label="Zoom out"
            title="Zoom out (-)"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span
            className="text-xs font-mono text-gray-300 select-none tabular-nums"
            title={effScale != null && Math.abs(effScale - 1) < 0.01 ? 'Actual size — one image pixel per screen pixel' : undefined}
          >
            {!zoomed || effScale == null ? 'Fit' : `${Math.round(effScale * 100)}%`}
          </span>
          <button
            type="button"
            onClick={() => stepZoom(1.4)}
            disabled={effScale != null && effScale >= MAX_SCALE}
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
          className="h-11 sm:h-9 px-3 sm:w-9 sm:px-0 flex items-center justify-center gap-1.5 rounded-full bg-gray-900/90 hover:bg-gray-800 text-gray-300 hover:text-white border border-gray-700 transition-colors shadow-lg"
          aria-label="Close zoom"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
          {/* Spelled out where there is no Esc key and no hover title. */}
          <span className="text-[13px] sm:hidden">Done</span>
        </button>
      </div>

      {/* Hint changes contextually — keystroke reference plus drag hint
          when zoomed in (where the panning capability is non-obvious). */}
      {!actions && (
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-gray-500 font-mono pointer-events-none bg-gray-900/60 rounded px-2 py-1">
        {!zoomed
          ? 'pinch or double-tap to zoom · click for 100% · esc to close'
          : 'drag to pan · pinch or double-tap out · + / − keys · esc to close'}
      </div>
      )}
    </div>
  )
}
