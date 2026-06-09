'use client'

export type PinType = 'entry' | 'stop' | 'tp1'
export interface Pin { x: number; y: number }

interface Props {
  imageUrl: string
  pins: Partial<Record<PinType, Pin>>
  /** When provided, the image becomes clickable and fires this callback —
   *  TradeForm uses it to open the shared ScreenshotLightbox modal. The
   *  pin-overlay SVG already uses pointer-events-none, so the click reaches
   *  the underlying button unimpeded. */
  onZoom?: () => void
}

const PIN_CFG: Record<PinType, { color: string; short: string }> = {
  entry: { color: '#22c55e', short: 'E' },
  stop:  { color: '#ef4444', short: 'S' },
  tp1:   { color: '#eab308', short: 'T' },
}

/**
 * Display-only trade screenshot with pin overlay. The interactive
 * "click-to-place a pin" UI was removed once /api/extract-trade started
 * auto-detecting entry/stop/TP1 prices from the screenshot — manual visual
 * marking became redundant. Legacy trades with saved entry_pin_x/y etc.
 * still render here so historical journal data isn't lost.
 */
export default function PinPlacement({ imageUrl, pins, onZoom }: Props) {
  // Wrap the image in a <button> when zoom is enabled so the entire image
  // area becomes a click target. Without onZoom, falls back to a plain
  // <img> to preserve the original purely-display behavior.
  const imageEl = onZoom ? (
    <button
      type="button"
      onClick={onZoom}
      className="block w-full cursor-zoom-in p-0 m-0 border-0 bg-transparent"
      title="Click to zoom"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="Trade screenshot"
        className="w-full object-contain max-h-[480px] transition-opacity hover:opacity-90"
      />
    </button>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={imageUrl} alt="Trade screenshot" className="w-full object-contain max-h-[480px]" />
  )
  return (
    <div className="relative rounded-xl overflow-hidden border border-gray-700 bg-gray-900">
      {imageEl}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
        {(Object.entries(pins) as [PinType, Pin][]).map(([type, pin]) => {
          const cfg = PIN_CFG[type]
          return (
            <g key={type}>
              <circle cx={`${pin.x}%`} cy={`${pin.y}%`} r="10" fill={cfg.color} fillOpacity="0.85" stroke="white" strokeWidth="2" />
              <text x={`${pin.x}%`} y={`${pin.y}%`} textAnchor="middle" dominantBaseline="central"
                fill="white" fontSize="9" fontWeight="bold">{cfg.short}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
