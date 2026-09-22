import type { AchievementId } from '@/lib/achievements'

/**
 * Custom SVG "achievement coin" — amber-on-graphite, replacing the old emoji.
 * One glyph per badge id. Two frames: `flat` (single amber ring, for the small
 * inline pill) and `double` (adds an inner ring — richer, for the big showcase /
 * share coin). Green accent (`#4ADE80`) lands only on the celebratory beats
 * (home-run ball, swish ball, flame core) so amber stays the identity.
 *
 * Clutch's glyph is a rising shooter releasing OVER a contesting defender (the
 * defender is drawn dimmed so the shooter stays the subject).
 */

const G = '#0c0a09'      // graphite ground
const RING = '#f59e0b'   // amber ring
const RING2 = '#b45309'  // deeper amber inner ring
const C = '#fbbf24'      // amber glyph
const GREEN = '#4ade80'  // celebratory accent

function Glyph({ id }: { id: AchievementId }) {
  switch (id) {
    case 'sniper':
      return (
        <>
          <g fill="none" stroke={C} strokeWidth={3} strokeLinecap="round">
            <circle cx={50} cy={50} r={17} />
            <circle cx={50} cy={50} r={8} strokeWidth={2.4} />
            <line x1={50} y1={26} x2={50} y2={34} />
            <line x1={50} y1={66} x2={50} y2={74} />
            <line x1={26} y1={50} x2={34} y2={50} />
            <line x1={66} y1={50} x2={74} y2={50} />
          </g>
          <circle cx={50} cy={50} r={2.6} fill={C} />
        </>
      )
    case 'grand_slam': // baseball — bat mid-swing + ball flying off with a home-run arc
      return (
        <>
          <path d="M30 62 Q48 24 72 34" fill="none" stroke={C} strokeWidth={2} strokeDasharray="3 4" strokeLinecap="round" opacity={0.55} />
          <line x1={30} y1={70} x2={52} y2={44} stroke={C} strokeWidth={6.5} strokeLinecap="round" />
          <circle cx={29} cy={71} r={3.2} fill={C} />
          <g stroke={C} strokeWidth={2} strokeLinecap="round" opacity={0.8}>
            <line x1={58} y1={40} x2={64} y2={37} />
            <line x1={56} y1={46} x2={62} y2={43} />
          </g>
          <circle cx={70} cy={33} r={6} fill={GREEN} />
          <path d="M66.5 30 Q70 33 66.5 36 M73.5 30 Q70 33 73.5 36" fill="none" stroke={G} strokeWidth={1.2} />
        </>
      )
    case 'clutch': // basketball — rising shooter releasing OVER a contesting defender
      return (
        <>
          {/* Defender, right: dimmed so the shooter stays the subject. Drawn
              FLAT-FOOTED (feet at y≈76 vs the shooter's ≈61) with the contesting
              hand at y≈37 — well below the ball at y≈23. That vertical gap is
              what makes the shot read as going OVER him. */}
          <g stroke={C} strokeWidth={2.6} strokeLinecap="round" fill="none" opacity={0.42}>
            <circle cx={69} cy={45} r={3.6} strokeWidth={2.4} />
            <line x1={69} y1={49} x2={69} y2={66} />
            <line x1={69} y1={66} x2={64} y2={76} />
            <line x1={69} y1={66} x2={74} y2={75} />
            <line x1={69} y1={53} x2={64} y2={37} />
            <line x1={69} y1={54} x2={76} y2={61} />
          </g>
          {/* Shooter, left: elevated mid-jump. BOTH arms fan up-RIGHT so the ball
              sits cocked above/right of the head — arms angled to opposite sides
              close a loop around the head and read as a balloon at small sizes. */}
          <circle cx={32} cy={37} r={4} fill="none" stroke={C} strokeWidth={2.6} />
          <g stroke={C} strokeWidth={3} strokeLinecap="round" fill="none">
            <line x1={34} y1={41} x2={35} y2={53} />
            <line x1={35} y1={53} x2={29} y2={62} />
            <line x1={35} y1={53} x2={42} y2={60} />
            <line x1={34} y1={44} x2={43} y2={31} />
            <line x1={34} y1={44} x2={38} y2={29} />
          </g>
          <circle cx={46} cy={23} r={5} fill={GREEN} />
          <path d="M42.3 20.1 Q46 23 42.3 25.9 M49.7 20.1 Q46 23 49.7 25.9" fill="none" stroke={G} strokeWidth={1.3} />
        </>
      )
    case 'career_day': // ascending bars + star on the tallest
      return (
        <>
          <g fill={C}>
            <rect x={27} y={58} width={9} height={14} rx={1.5} />
            <rect x={39} y={50} width={9} height={22} rx={1.5} />
            <rect x={51} y={42} width={9} height={30} rx={1.5} />
            <rect x={63} y={34} width={9} height={38} rx={1.5} />
          </g>
          <path d="M67.5 20 l2.1 4.3 4.7 0.7 -3.4 3.3 0.8 4.7 -4.2 -2.2 -4.2 2.2 0.8 -4.7 -3.4 -3.3 4.7 -0.7 z" fill={C} />
        </>
      )
    case 'heat_check': // teardrop flame, green inner core
      return (
        <>
          <path d="M50 24 C58 34 66 40 66 52 C66 63 59 71 50 71 C41 71 34 63 34 52 C34 44 39 40 44 34 C45 40 48 43 51 44 C50 38 49 31 50 24 Z" fill="none" stroke={C} strokeWidth={3.2} strokeLinejoin="round" />
          <path d="M50 44 C55 50 57 54 57 58 C57 63 54 66 50 66 C46 66 43 63 43 58 C43 53 47 49 50 44 Z" fill={GREEN} />
        </>
      )
  }
}

export default function AchievementCoin({
  id,
  size = 48,
  ring = 'double',
  className,
  title,
}: {
  id: AchievementId
  size?: number
  /** `flat` = one amber ring (small pill); `double` = adds an inner ring (big coin). */
  ring?: 'flat' | 'double'
  className?: string
  title?: string
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title ?? id}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <circle cx={50} cy={50} r={47} fill={G} />
      <circle cx={50} cy={50} r={ring === 'double' ? 46 : 45} fill="none" stroke={RING} strokeWidth={ring === 'double' ? 3.4 : 3} />
      {ring === 'double' && <circle cx={50} cy={50} r={40} fill="none" stroke={RING2} strokeWidth={1.4} opacity={0.8} />}
      <Glyph id={id} />
    </svg>
  )
}
