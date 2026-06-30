import type { NewsEvent } from '@/lib/economic-calendar'

/**
 * Red-folder (high-impact) economic news for the day, pinned to the top of
 * prep. Server-fetched and passed in; renders nothing when there's no
 * high-impact news (so a quiet day / feed hiccup just shows no banner).
 *
 * Times are shown in PT (the app convention) with the original ET in a
 * tooltip — news is conventionally referenced in ET, and ET is how you'd
 * cross-check against Forex Factory.
 */
export default function HighImpactNews({ events }: { events: NewsEvent[] }) {
  if (!events || events.length === 0) return null
  return (
    <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm">🔴</span>
        <span className="text-[11px] font-semibold text-red-300 uppercase tracking-wider">
          High-impact news today
        </span>
      </div>
      <ul className="space-y-1">
        {events.map((e, i) => (
          <li key={i} className="flex items-baseline gap-3 text-sm">
            <span
              className="font-mono text-xs text-red-200 w-20 flex-shrink-0 tabular-nums"
              title={`${e.timeEt} ET`}
            >
              {e.timePt ?? e.timeEt}
            </span>
            <span className="text-gray-200">{e.title}</span>
            <span className="text-[10px] text-gray-500">{e.country}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
