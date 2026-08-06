import AchievementCoin from '@/components/AchievementCoin'
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_ORDER, type AchievementId } from '@/lib/achievements'

/**
 * The full trophy case — every badge with its lifetime ×N count, unearned ones
 * dimmed. Lives on the DASHBOARD; the EOD recap deliberately shows only that
 * day's earns (see AchievementShowcase). `counts` = achievementCounts() over the
 * user's persisted trading_days.achievements_json.
 */
export default function AchievementCollection({
  counts,
  className,
}: {
  counts: Record<AchievementId, number>
  className?: string
}) {
  const cnt = (id: AchievementId) => counts?.[id] ?? 0

  return (
    <div className={className}>
      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wide">Your collection</h3>
      <div className="mt-3 flex flex-wrap gap-4">
        {ACHIEVEMENT_ORDER.map(id => {
          const c = ACHIEVEMENT_CATALOG[id]
          const n = cnt(id)
          const lit = n > 0
          return (
            <div
              key={id}
              className={`flex flex-col items-center gap-1 w-[78px] ${lit ? '' : 'opacity-30 grayscale'}`}
              title={c.blurb}
            >
              <AchievementCoin id={id} size={44} ring="flat" title={c.label} />
              <div className="text-[10.5px] font-bold text-gray-300 text-center leading-tight">{c.label}</div>
              <div className="text-[10px] text-gray-500">{n > 0 ? `×${n}` : '—'}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
