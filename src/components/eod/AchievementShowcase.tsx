import AchievementCoin from '@/components/AchievementCoin'
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_ORDER, type Achievement, type AchievementId } from '@/lib/achievements'

/**
 * The "bigger" achievement treatment for the EOD recap: a row of large coins
 * for what was earned TODAY (glyph + name + the day's story + lifetime count),
 * plus a dimmed "collection" strip of all badges with their lifetime counts.
 *
 * `counts` come from persisted trading_days.achievements_json across the user's
 * history (server-computed via achievementCounts). Missing/zero counts degrade
 * gracefully — before the backfill runs, a coin earned today just reads
 * "First time!". Renders nothing when there's neither an earned-today badge nor
 * any history.
 */
export default function AchievementShowcase({
  earned,
  counts,
  className,
}: {
  earned: Achievement[]
  counts?: Record<AchievementId, number>
  className?: string
}) {
  const earnedIds = new Set(earned.map(a => a.id))
  const cnt = (id: AchievementId) => counts?.[id] ?? 0
  const hasHistory = ACHIEVEMENT_ORDER.some(id => cnt(id) > 0)

  if (earned.length === 0 && !hasHistory) return null

  return (
    <div className={`rounded-2xl border border-gray-800 bg-gray-900/40 p-5 ${className ?? ''}`}>
      {earned.length > 0 && (
        <>
          <h3 className="text-sm font-bold text-amber-300 flex items-center gap-2">
            <span aria-hidden>🏅</span> Achievements earned today
          </h3>
          <p className="text-[11px] text-gray-500 mt-0.5">The coins you banked this session, with your all-time count.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {earned.map(a => {
              const n = Math.max(cnt(a.id), 1) // today's may not be persisted yet
              return (
                <div
                  key={a.id}
                  className="flex-1 min-w-[210px] flex items-start gap-3 rounded-xl border border-gray-800 bg-black/30 p-4"
                >
                  <div className="relative shrink-0">
                    <AchievementCoin id={a.id} size={60} ring="double" title={a.label} />
                    <span
                      className="absolute -top-1.5 -right-2 rounded-full bg-amber-500 text-[11px] font-extrabold text-amber-950 px-1.5 py-px border-2 border-gray-900"
                      title={`Earned ${n}× all-time`}
                    >
                      ×{n}
                    </span>
                  </div>
                  <div>
                    <div className="text-[15px] font-extrabold text-amber-300">{a.label}</div>
                    <div className="text-[11.5px] leading-snug text-gray-400 mt-0.5">{a.blurb}</div>
                    {/* Once-per-day coin: the trader earned this TODAY; the count is
                        lifetime, so label it all-time to avoid reading as "twice today". */}
                    <div className="text-[11px] text-gray-500 mt-1.5">
                      Earned today · {n > 1 ? <><b className="text-gray-300 font-bold">{n}×</b> all-time</> : <b className="text-gray-300 font-bold">first time ever</b>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <h3 className={`text-xs font-bold text-gray-400 uppercase tracking-wide ${earned.length > 0 ? 'mt-5' : ''}`}>
        Your collection
      </h3>
      <div className="mt-3 flex flex-wrap gap-4">
        {ACHIEVEMENT_ORDER.map(id => {
          const c = ACHIEVEMENT_CATALOG[id]
          const n = cnt(id)
          const litToday = earnedIds.has(id)
          const lit = litToday || n > 0
          return (
            <div
              key={id}
              className={`flex flex-col items-center gap-1 w-[78px] ${lit ? '' : 'opacity-30 grayscale'}`}
              title={c.blurb}
            >
              <AchievementCoin id={id} size={44} ring="flat" title={c.label} />
              <div className="text-[10.5px] font-bold text-gray-300 text-center leading-tight">{c.label}</div>
              <div className="text-[10px] text-gray-500">{n > 0 ? `×${n}` : litToday ? '×1' : '—'}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
