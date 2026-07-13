import type { Achievement } from '@/lib/achievements'
import AchievementCoin from '@/components/AchievementCoin'

/**
 * Renders earned achievement badges as amber pills (custom coin + label), each
 * with its "why you earned it" blurb on hover. Presentational + pure — the
 * caller computes the list via dayAchievements(). Renders nothing when empty.
 *
 * The big showcase + Share "show off" reuse the same AchievementCoin at larger
 * sizes; here it's the small flat-ring glyph inline with the label.
 */
export default function AchievementBadges({
  items,
  className,
}: {
  items: Achievement[]
  className?: string
}) {
  if (!items || items.length === 0) return null
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {items.map(a => (
        <span
          key={a.id}
          title={a.blurb}
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 pl-1 pr-2 py-0.5 text-xs font-medium text-amber-200 whitespace-nowrap cursor-default"
        >
          <AchievementCoin id={a.id} size={18} ring="flat" title={a.label} />
          {a.label}
        </span>
      ))}
    </div>
  )
}
