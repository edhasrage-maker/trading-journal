'use client'

/**
 * Entry-efficiency readout: average MFE vs average MAE in ATR units, with a
 * plain-English verdict. Answers "do I take more heat than I capture?" (→ late
 * entries) from bars alone — no planned stop needed, so it lights up on a
 * fills-only import. Renders nothing until there's excursion+ATR data.
 */
export default function MfeMaeEfficiency({
  mfe,
  mae,
  count,
}: {
  mfe: number | null
  mae: number | null
  count: number
}) {
  if (mfe == null || mae == null || count === 0) return null

  const scale = Math.max(mfe, mae, 1.5)
  const maePct = Math.round((mae / scale) * 100)
  const mfePct = Math.round((mfe / scale) * 100)

  // Verdict bands. "Late" = you routinely sit through more heat than you bank —
  // an entry-timing problem. "Sharp" = you capture more than the heat you take.
  const late = mae >= mfe * 1.2
  const sharp = mfe >= mae * 1.2
  const verdict = late
    ? `You take ${mae.toFixed(1)}×ATR of heat to capture ${mfe.toFixed(1)}×ATR — your entries are running late. Review timing on the flagged trades below.`
    : sharp
      ? `You capture ${mfe.toFixed(1)}×ATR while taking only ${mae.toFixed(1)}×ATR of heat — your entry timing is sharp.`
      : `Heat (${mae.toFixed(1)}×ATR) and capture (${mfe.toFixed(1)}×ATR) are roughly balanced.`

  const tone = late
    ? { bg: 'rgba(224,163,60,0.09)', border: 'rgba(224,163,60,0.32)', text: 'text-amber-200' }
    : sharp
      ? { bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.30)', text: 'text-green-200' }
      : { bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.35)', text: 'text-gray-300' }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-3">
        Entry efficiency · {count} trade{count === 1 ? '' : 's'} · heat vs capture (×ATR)
      </div>

      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-28 shrink-0 text-right text-xs text-gray-400">Heat taken (MAE)</span>
        <div className="flex-1 h-4 bg-gray-950 rounded overflow-hidden">
          <div className="h-full bg-gray-500" style={{ width: `${maePct}%` }} />
        </div>
        <span className="w-16 shrink-0 text-xs text-gray-300 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{mae.toFixed(1)}×ATR</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-right text-xs text-gray-400">Move captured (MFE)</span>
        <div className="flex-1 h-4 bg-gray-950 rounded overflow-hidden">
          <div className="h-full bg-green-400" style={{ width: `${mfePct}%` }} />
        </div>
        <span className="w-16 shrink-0 text-xs text-green-400 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{mfe.toFixed(1)}×ATR</span>
      </div>

      <div className="mt-3 rounded-lg px-3 py-2.5 border" style={{ background: tone.bg, borderColor: tone.border }}>
        <p className={`text-[13px] leading-relaxed ${tone.text}`}>{verdict}</p>
      </div>
    </div>
  )
}
