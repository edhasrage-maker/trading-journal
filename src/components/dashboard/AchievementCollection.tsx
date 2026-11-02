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
  compact = false,
}: {
  counts: Record<AchievementId, number>
  className?: string
  /** One quiet line of chips — earned ones outlined with ×N, the rest dashed.
   *  The Detailed dashboard closes on it (founder, 2026-10-31; chips
   *  2026-11-01). */
  compact?: boolean
}) {
  const cnt = (id: AchievementId) => counts?.[id] ?? 0

  if (compact) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
        <h3 className="mr-2 text-[16px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Your collection</h3>
        {ACHIEVEMENT_ORDER.map(id => {
          const c = ACHIEVEMENT_CATALOG[id]
          const n = cnt(id)
          return (
            <span
              key={id}
              className={`inline-flex items-center gap-1.5 text-[13px] rounded-full pl-1 pr-3 py-0.5 border ${n > 0 ? 'border-gray-500 text-gray-100' : 'border-dashed border-gray-700 text-gray-500'}`}
              title={n > 0 ? c.blurb : `${c.blurb} Not earned yet.`}
            >
              <span className={n > 0 ? 'inline-flex' : 'inline-flex opacity-30 grayscale'}>
                <AchievementCoin id={id} size={20} ring="flat" title={c.label} />
              </span>
              {c.label}{n > 0 && <b> ×{n}</b>}
            </span>
          )
        })}
      </div>
    )
  }

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
