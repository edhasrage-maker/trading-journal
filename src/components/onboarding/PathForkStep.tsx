'use client'

import { Target, Compass, ChevronRight } from 'lucide-react'

/**
 * The very first onboarding screen — a one-tap fork that splits new users from
 * experienced ones. A veteran gets the full playbook capture; someone still
 * finding their style gets a single light screen and a coach that learns as
 * they log. Both converge on one trader profile.
 */
export default function PathForkStep({
  onPick, onSkipAll,
}: {
  onPick: (path: 'veteran' | 'new') => void
  onSkipAll: () => void
}) {
  const cards: Array<{ path: 'veteran' | 'new'; icon: typeof Target; title: string; sub: string; blurb: string }> = [
    {
      path: 'veteran',
      icon: Target,
      title: 'I trade a system',
      sub: 'Veteran',
      blurb: 'You have named setups, rules, and a routine. We’ll capture your full playbook so the coach grades you your way.',
    },
    {
      path: 'new',
      icon: Compass,
      title: 'Still finding my style',
      sub: 'New',
      blurb: 'New or between systems? Start light — one screen, then your coach sharpens as you log trades.',
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Where are you at?</h2>
        <p className="text-sm text-gray-400 mt-1">This just sets how much we ask up front. You can change any of it later.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map(c => {
          const Icon = c.icon
          return (
            <button
              key={c.path}
              type="button"
              onClick={() => onPick(c.path)}
              className="group text-left border border-gray-800 hover:border-blue-600 bg-gray-950/40 hover:bg-blue-950/20 rounded-xl p-5 transition-colors focus:outline-none focus:border-blue-500"
            >
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg border border-gray-700 group-hover:border-blue-600 text-blue-400 transition-colors">
                  <Icon className="w-5 h-5" />
                </span>
                <span className="text-[10px] uppercase tracking-wider text-gray-600 group-hover:text-blue-400 transition-colors">{c.sub}</span>
              </div>
              <div className="mt-4 flex items-center gap-1 text-white font-medium">
                {c.title}
                <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-blue-400 group-hover:translate-x-0.5 transition-all" />
              </div>
              <p className="text-sm text-gray-400 mt-1.5 leading-relaxed">{c.blurb}</p>
            </button>
          )
        })}
      </div>

      <div className="pt-1">
        <button type="button" onClick={onSkipAll} className="text-sm text-gray-500 hover:text-gray-300">Skip for now</button>
      </div>
    </div>
  )
}
