'use client'

import AutoGrowTextarea from '@/components/AutoGrowTextarea'
import type { PrepNotes, PriceScenario } from '@/lib/supabase/types'

// Discord-card "day stance" — the plain-language verdict a casual viewer reads
// first. Three traffic-light states so it stays instantly legible.
const dayStanceOptions: { value: 'go' | 'caution' | 'avoid'; label: string; on: string }[] = [
  { value: 'go', label: 'Go', on: 'bg-emerald-600 border-emerald-500 text-white' },
  { value: 'caution', label: 'Caution', on: 'bg-amber-600 border-amber-500 text-white' },
  { value: 'avoid', label: 'Sit out', on: 'bg-red-600 border-red-500 text-white' },
]

/**
 * Inputs that feed the Discord share card: the AI-set viewer read (day stance +
 * one-line read) and the "Where price can go" Plan A / Plan B roadmap. Lives
 * directly above the DiscordDashboard preview (PrepClient) so the fields sit next
 * to the card they populate, at the very bottom of the prep — not in Prep Notes.
 * day_stance + day_read are auto-populated by Analyze (analyze-prep); all editable.
 */
export default function DiscordCardInputs({
  value,
  onChange,
}: {
  value: PrepNotes
  onChange: (v: PrepNotes) => void
}) {
  const set = (key: keyof PrepNotes, val: unknown) => onChange({ ...value, [key]: val })

  const scenarios = value.price_scenarios ?? []
  const getScenario = (role: 'favored' | 'alt') => scenarios.find(s => s.role === role)
  const setScenario = (role: 'favored' | 'alt', patch: Partial<PriceScenario>) => {
    const existing = getScenario(role)
    const merged: PriceScenario = {
      role,
      direction: patch.direction ?? existing?.direction ?? (role === 'favored' ? 'down' : 'up'),
      trigger: patch.trigger ?? existing?.trigger ?? '',
      target: patch.target ?? existing?.target ?? '',
    }
    const next = [merged, ...scenarios.filter(s => s.role !== role)]
      .sort((a) => (a.role === 'favored' ? -1 : 1))
    set('price_scenarios', next)
  }

  return (
    <div className="mb-5">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Discord card — viewer read</h3>
      <p className="text-xs text-gray-600 mb-3">Set automatically when you Analyze — change anything you don’t agree with.</p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Day stance (AI-set — tap to override)</label>
          <div className="flex gap-2">
            {dayStanceOptions.map(o => (
              <button key={o.value} type="button"
                onClick={() => set('day_stance', value.day_stance === o.value ? undefined : o.value)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  value.day_stance === o.value ? o.on : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >{o.label}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">One-line read (AI-set — edit to override)</label>
          <AutoGrowTextarea rows={1} spellCheck autoCorrect="on"
            placeholder="e.g. Choppy, low-energy open — let it pick a side first."
            value={value.day_read ?? ''} onChange={e => set('day_read', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
          />
        </div>
      </div>

      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-5 mb-3">Where price can go</h3>
      <div className="space-y-2">
        {(['favored', 'alt'] as const).map(role => {
          const sc = getScenario(role)
          const dir = sc?.direction ?? (role === 'favored' ? 'down' : 'up')
          return (
            <div key={role} className="flex items-center gap-2">
              <span className={`w-16 shrink-0 text-xs font-semibold uppercase ${role === 'favored' ? 'text-blue-400' : 'text-gray-500'}`}>
                {role === 'favored' ? 'Plan A' : 'Plan B'}
              </span>
              <button type="button"
                onClick={() => setScenario(role, { direction: dir === 'up' ? 'down' : 'up' })}
                className={`w-9 shrink-0 py-1.5 rounded-lg text-sm font-bold border transition-colors ${
                  dir === 'up' ? 'bg-green-700 border-green-600 text-white' : 'bg-red-800 border-red-700 text-white'
                }`}
                title="Toggle direction"
              >{dir === 'up' ? '▲' : '▼'}</button>
              <input type="text" placeholder="trigger (e.g. 28910)"
                value={sc?.trigger ?? ''} onChange={e => setScenario(role, { trigger: e.target.value })}
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 text-white rounded-lg px-2.5 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <span className="shrink-0 text-gray-500 text-sm">→</span>
              <input type="text" placeholder="target (e.g. 28710)"
                value={sc?.target ?? ''} onChange={e => setScenario(role, { target: e.target.value })}
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 text-white rounded-lg px-2.5 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
