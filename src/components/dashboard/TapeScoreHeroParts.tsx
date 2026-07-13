'use client'

/**
 * Shared One-TapeScore hero primitives (Pt 13).
 *
 * The 0-100 ring, the component chip, and the band→color map are used by BOTH
 * the Detailed dashboard hero (DashboardStats) and the Highlights hero
 * (BeginnerDashboard) so the score reads identically in both modes — "one
 * score everywhere." Keep these free of period/verdict logic; each hero owns
 * its own surrounding copy.
 */

export type HeroBand = 'high' | 'mid' | 'low' | null

/** Band → color classes shared by the ring stroke and the score text. */
export function bandColors(band: HeroBand): { stroke: string; text: string } {
  switch (band) {
    case 'high': return { stroke: '#4ade80', text: 'text-green-400' }
    case 'mid': return { stroke: '#fbbf24', text: 'text-amber-300' }
    case 'low': return { stroke: '#f87171', text: 'text-red-400' }
    default: return { stroke: '#374151', text: 'text-gray-500' }
  }
}

/** The 0-100 TapeScore ring. `score` null renders an em-dash with a grey ring. */
export function TapeScoreRing({ score, band, title }: {
  score: number | null
  band: HeroBand
  title?: string
}) {
  const colors = bandColors(band)
  const R = 40
  const CIRC = 2 * Math.PI * R
  const dash = score != null ? (score / 100) * CIRC : 0
  return (
    <div className="relative w-[92px] h-[92px] shrink-0" title={title}>
      <svg width="92" height="92" viewBox="0 0 92 92" className="-rotate-90">
        <circle cx="46" cy="46" r={R} fill="none" stroke="#1f2937" strokeWidth="7" />
        {score != null && (
          <circle
            cx="46" cy="46" r={R} fill="none"
            stroke={colors.stroke} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC}`}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div className={`font-mono text-[26px] font-extrabold ${colors.text}`}>{score ?? '—'}</div>
          <div className="text-[8px] tracking-[0.14em] text-gray-500 mt-0.5">TAPESCORE</div>
        </div>
      </div>
    </div>
  )
}

/** A single component chip (Rules kept / Execution / Prep). */
export function HeroChip({ label, tone, title }: { label: string; tone: 'good' | 'mid' | 'bad'; title: string }) {
  const cls =
    tone === 'good' ? 'border-green-800/60 text-green-300 bg-green-950/40'
    : tone === 'mid' ? 'border-amber-800/60 text-amber-300 bg-amber-950/40'
    : 'border-red-800/60 text-red-300 bg-red-950/40'
  return (
    <span className={`inline-flex items-center text-[11px] px-2.5 py-0.5 rounded-full border whitespace-nowrap ${cls}`} title={title}>
      {label}
    </span>
  )
}
