import Link from 'next/link'
import { hitTotals, type TagHitRate } from '@/lib/coach-tag-audit'

/**
 * Settings → Tags → "How often the coach gets your tags right" (founder,
 * 2026-10-28; mockup https://claude.ai/artifact/3zaJp7LnBug1pjs1wwAX23,
 * Settings artboard). One row per tag the coach picked or missed, all weeks,
 * this trader only (src/lib/coach-tag-audit.ts). Read-only; the checking
 * happens in the weekly review.
 */
export default function CoachAccuracy({ rates, groupLabel, weekHref }: {
  rates: TagHitRate[]
  groupLabel: (category: string) => string
  /** This week's review, where the tags are checked. */
  weekHref: string
}) {
  const tot = hitTotals(rates)
  const th = 'px-3.5 py-2.5 font-semibold text-[11px] uppercase tracking-[0.06em]'
  const td = 'px-3.5 py-[9px]'
  return (
    <section id="coach-accuracy" className="mt-10 pt-6 border-t border-gray-700">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-base font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>How often the coach gets your tags right</h2>
        <span className="text-[13px] text-gray-300 tabular-nums">
          <b className="text-gray-100 font-semibold">{tot.picked}</b> picked · <b className="text-gray-100 font-semibold">{tot.kept + tot.removed}</b> checked
        </span>
      </div>
      <p className="mt-2.5 mb-3.5 text-[13.5px] leading-relaxed text-gray-300 max-w-[820px]">
        Right = kept ÷ (kept + taken off). “You added” = a tag you put on that the coach didn&apos;t pick. Only trades the coach tagged; your rules&apos; tags, your day labels and emotions are never counted.{' '}
        <Link href={weekHref} className="text-blue-300 hover:text-blue-200">Check this week&apos;s tags</Link>
      </p>
      {rates.length === 0 ? (
        <p className="text-[13px] text-gray-400">The coach hasn&apos;t picked any tags on your trades yet.</p>
      ) : (
        <div className="overflow-x-auto border border-gray-800 rounded-lg">
          <table className="w-full min-w-[720px] border-collapse text-[13px] tabular-nums">
            <thead>
              <tr className="bg-gray-900 text-gray-400 text-left">
                <th className={th}>Tag</th>
                <th className={th}>Group</th>
                <th className={`${th} text-right`}>Picked</th>
                <th className={`${th} text-right`}>Kept</th>
                <th className={`${th} text-right`}>Taken off</th>
                <th className={`${th} text-right`}>You added</th>
                <th className={`${th} text-right`}>To check</th>
                <th className={`${th} text-right`}>Right</th>
              </tr>
            </thead>
            <tbody>
              {rates.map(r => (
                <tr key={`${r.category}|${r.label}`} className="border-t border-gray-800">
                  <td className={`${td} text-gray-100`}>{r.label}</td>
                  <td className={`${td} text-gray-400`}>{groupLabel(r.category)}</td>
                  <td className={`${td} text-right text-gray-200`}>{r.picked}</td>
                  <td className={`${td} text-right text-blue-300`}>{r.kept}</td>
                  <td className={`${td} text-right text-[#E8A15A]`}>{r.removed}</td>
                  <td className={`${td} text-right text-gray-200`}>{r.added}</td>
                  <td className={`${td} text-right text-gray-400`}>{r.pending}</td>
                  <td className={`${td} text-right text-gray-100 font-semibold`}>{r.right == null ? '—' : `${Math.round(r.right * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
