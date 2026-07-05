import type { Achievement } from '@/lib/achievements'

/**
 * Renders earned achievement badges as amber pills (emoji + label), each with
 * its "why you earned it" blurb on hover. Presentational + pure — the caller
 * computes the list via dayAchievements(). Renders nothing when empty.
 *
 * The Share "show off" action hangs off these later; for now they're the
 * visible reward on the day.
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
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-200 whitespace-nowrap cursor-default"
        >
          <span aria-hidden>{a.emoji}</span>
          {a.label}
        </span>
      ))}
    </div>
  )
}
