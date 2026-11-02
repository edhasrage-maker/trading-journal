import { tapeScoreBand } from '@/lib/tapescore'

/** A day's TapeScore as a small chip on the dashboard's blue score ramp
 *  (globals.css --score-*), so green and red stay for money. */
export default function ScoreChip({ score, className = '' }: { score: number; className?: string }) {
  const b = tapeScoreBand(score)
  return (
    <span
      className={`font-bold tabular-nums rounded px-1.5 leading-[18px] ${className}`}
      style={{ background: `var(--score-${b})`, color: `var(--score-${b}-ink)`, fontFamily: 'var(--font-display)' }}
      title={`TapeScore ${score} out of 100`}
    >
      {score}
    </span>
  )
}
