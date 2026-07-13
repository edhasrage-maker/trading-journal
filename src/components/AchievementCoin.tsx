import type { AchievementId } from '@/lib/achievements'

/**
 * Custom SVG "achievement coin" — amber-on-graphite, replacing the old emoji.
 * One glyph per badge id. Two frames: `flat` (single amber ring, for the small
 * inline pill) and `double` (adds an inner ring — richer, for the big showcase /
 * share coin). Green accent (`#4ADE80`) lands only on the celebratory beats
 * (home-run ball, swish ball, flame core) so amber stays the identity.
 *
 * Game Winner's glyph (shooter + arc + hoop) is a PLACEHOLDER pending a nicer
 * basketball mark — swap just the `game_winner` case when it's ready.
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
    case 'game_winner': // basketball — shooter releasing a long three toward the hoop (PLACEHOLDER)
      return (
        <>
          <path d="M18 74 Q22 60 30 58" fill="none" stroke={C} strokeWidth={2} strokeLinecap="round" opacity={0.5} />
          <circle cx={30} cy={50} r={3.6} fill="none" stroke={C} strokeWidth={2.4} />
          <g stroke={C} strokeWidth={2.6} strokeLinecap="round" fill="none">
            <line x1={30} y1={54} x2={30} y2={63} />
            <line x1={30} y1={63} x2={25} y2={73} />
            <line x1={30} y1={63} x2={35} y2={72} />
            <line x1={30} y1={57} x2={24} y2={52} />
            <line x1={30} y1={57} x2={37} y2={47} />
          </g>
          <circle cx={41} cy={43} r={4.2} fill={GREEN} />
          <path d="M43 41 Q60 18 73 40" fill="none" stroke={C} strokeWidth={2} strokeDasharray="3 4" strokeLinecap="round" opacity={0.7} />
          <line x1={76} y1={30} x2={76} y2={44} stroke={C} strokeWidth={2.4} strokeLinecap="round" />
          <ellipse cx={70} cy={44} rx={7} ry={2.4} fill="none" stroke={C} strokeWidth={2.4} />
          <path d="M64 45 L66 53 M70 46 L70 55 M76 45 L74 53" fill="none" stroke={C} strokeWidth={1.6} opacity={0.8} />
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
