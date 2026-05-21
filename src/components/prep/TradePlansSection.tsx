'use client'

import { useState } from 'react'
import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import type { TradePlan, PlanAssessment } from '@/lib/supabase/types'

const PRESET_SETUPS = ['Supply/Demand', 'Break/Retest', 'LVN/Hold', 'EMA Trend Following', 'Reversal Trade']

interface Props {
  plans: TradePlan[]
  onChange: (plans: TradePlan[]) => void
  planAssessments?: PlanAssessment[]
}

const qualityColor = (n: number) =>
  n <= 2 ? 'bg-red-700 border-red-600 text-white'
  : n === 3 ? 'bg-yellow-700 border-yellow-600 text-white'
  : 'bg-green-700 border-green-600 text-white'

export default function TradePlansSection({ plans, onChange, planAssessments }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Track which plans are using a custom (non-preset) setup name
  const [customMode, setCustomMode] = useState<Set<string>>(
    () => new Set(plans.filter(p => p.setup_name && !PRESET_SETUPS.includes(p.setup_name)).map(p => p.id))
  )

  const addPlan = () => {
    const id = Date.now().toString()
    onChange([...plans, { id, direction: 'long', setup_name: '', quality: 3, quality_reasons: [], invalidation: '', targets: '', scary_factors: '' }])
    setExpanded(prev => new Set([...prev, id]))
  }

  const update = (id: string, patch: Partial<TradePlan>) =>
    onChange(plans.map(p => p.id === id ? { ...p, ...patch } : p))

  const remove = (id: string) => onChange(plans.filter(p => p.id !== id))

  const toggle = (id: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const addReason = (id: string) => {
    const p = plans.find(p => p.id === id)
    if (p) update(id, { quality_reasons: [...p.quality_reasons, ''] })
  }

  const setReason = (id: string, idx: number, val: string) => {
    const p = plans.find(p => p.id === id)
    if (!p) return
    const r = [...p.quality_reasons]; r[idx] = val
    update(id, { quality_reasons: r })
  }

  const removeReason = (id: string, idx: number) => {
    const p = plans.find(p => p.id === id)
    if (p) update(id, { quality_reasons: p.quality_reasons.filter((_, i) => i !== idx) })
  }

  return (
    <div className="space-y-3">
      {plans.length === 0 && (
        <p className="text-sm text-gray-500 italic">No setups added yet.</p>
      )}

      {plans.map(plan => {
        const isOpen = expanded.has(plan.id)
        const assess = planAssessments?.find(a => a.plan_id === plan.id)
        const aiAgrees = assess != null && assess.ai_quality >= plan.quality

        return (
          <div key={plan.id} className="border border-gray-700 rounded-xl overflow-hidden">

            {/* Header row */}
            <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-800/60 cursor-pointer select-none"
              onClick={() => toggle(plan.id)}>
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${plan.direction === 'long' ? 'bg-green-700 text-white' : 'bg-red-700 text-white'}`}>
                {plan.direction === 'long' ? '▲ L' : '▼ S'}
              </span>
              <span className="text-sm font-medium text-white flex-1 truncate">
                {plan.setup_name || <span className="text-gray-500 italic">Unnamed Setup</span>}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${qualityColor(plan.quality)}`}>{plan.quality}/5</span>
                {assess && (
                  <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${aiAgrees ? 'bg-green-900/40 border-green-600/60 text-green-400' : 'bg-orange-900/40 border-orange-600/60 text-orange-400'}`}>
                    AI {assess.ai_quality}/5
                  </span>
                )}
                {isOpen ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
              </div>
            </div>

            {/* Body */}
            {isOpen && (
              <div className="p-4 space-y-4 bg-gray-900 border-t border-gray-700/50">

                {/* Direction + Name */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Direction</label>
                    <div className="flex gap-1">
                      {(['long', 'short'] as const).map(d => (
                        <button key={d} type="button" onClick={() => update(plan.id, { direction: d })}
                          className={`flex-1 py-1.5 text-xs font-bold rounded border transition-colors ${
                            plan.direction === d
                              ? d === 'long' ? 'bg-green-700 border-green-600 text-white' : 'bg-red-700 border-red-600 text-white'
                              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                          }`}
                        >{d === 'long' ? '▲ Long' : '▼ Short'}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Setup Type</label>
                    <select
                      value={customMode.has(plan.id) ? '__custom__' : (plan.setup_name || '')}
                      onChange={e => {
                        if (e.target.value === '__custom__') {
                          setCustomMode(s => new Set([...s, plan.id]))
                          update(plan.id, { setup_name: '' })
                        } else {
                          setCustomMode(s => { const n = new Set(s); n.delete(plan.id); return n })
                          update(plan.id, { setup_name: e.target.value })
                        }
                      }}
                      className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                      <option value="">Select type...</option>
                      {PRESET_SETUPS.map(s => <option key={s} value={s}>{s}</option>)}
                      <option value="__custom__">Other (custom)</option>
                    </select>
                    {customMode.has(plan.id) && (
                      <input type="text" spellCheck autoCorrect="on" placeholder="Describe the setup..."
                        value={plan.setup_name}
                        onChange={e => update(plan.id, { setup_name: e.target.value })}
                        className="w-full mt-1.5 bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    )}
                  </div>
                </div>

                {/* Quality */}
                <div>
                  <label className="block text-xs text-gray-400 mb-2">Quality Rating</label>
                  <div className="flex gap-1 mb-3">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button key={n} type="button" onClick={() => update(plan.id, { quality: n })}
                        className={`flex-1 py-2 text-sm font-bold rounded-lg border transition-colors ${
                          plan.quality === n ? qualityColor(n) : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                        }`}
                      >{n}</button>
                    ))}
                  </div>

                  {/* Bullet reasons */}
                  <div className="space-y-1.5 mb-1">
                    {plan.quality_reasons.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-gray-500 text-xs shrink-0">•</span>
                        <input type="text" spellCheck autoCorrect="on" placeholder="Reason for this rating..."
                          value={r} onChange={e => setReason(plan.id, i, e.target.value)}
                          className="flex-1 bg-gray-800 border border-gray-700 text-white rounded px-2 py-1 text-xs placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
                        />
                        <button type="button" onClick={() => removeReason(plan.id, i)}
                          className="text-gray-600 hover:text-red-400 transition-colors text-xs shrink-0">✕</button>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addReason(plan.id)}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                    + Add reason
                  </button>

                  {/* AI rating */}
                  {assess && (
                    <div className={`mt-3 p-3 rounded-lg border text-xs space-y-1 ${
                      aiAgrees ? 'bg-green-900/20 border-green-700/50' : 'bg-orange-900/20 border-orange-700/50'
                    }`}>
                      <div className={`font-semibold ${aiAgrees ? 'text-green-400' : 'text-orange-400'}`}>
                        AI Rating: {assess.ai_quality}/5 — {aiAgrees ? '✓ Agrees with your assessment' : '⚠ Disagrees — see note'}
                      </div>
                      <p className="text-gray-400 leading-relaxed">{assess.note}</p>
                    </div>
                  )}
                </div>

                {/* Invalidation */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Where is the plan invalidated?</label>
                  <input type="text" spellCheck autoCorrect="on" placeholder="e.g. Close under 27886 / Print above ONH"
                    value={plan.invalidation} onChange={e => update(plan.id, { invalidation: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                {/* Targets */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">What are my targets?</label>
                  <input type="text" spellCheck autoCorrect="on" placeholder="e.g. 2R, ONH, 50% extension"
                    value={plan.targets} onChange={e => update(plan.id, { targets: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                {/* Scary factors */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">What would make this trade scary to take?</label>
                  <input type="text" spellCheck autoCorrect="on" placeholder="e.g. Rejecting from ONH first, no clean structure"
                    value={plan.scary_factors} onChange={e => update(plan.id, { scary_factors: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="flex justify-end pt-1 border-t border-gray-800">
                  <button type="button" onClick={() => remove(plan.id)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 transition-colors mt-2">
                    <Trash2 className="w-3 h-3" /> Remove setup
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      <button type="button" onClick={addPlan}
        className="flex items-center gap-2 w-full justify-center border border-dashed border-gray-700 hover:border-gray-500 text-gray-500 hover:text-gray-200 text-sm py-3 rounded-xl transition-colors bg-gray-800/30 hover:bg-gray-800/60"
      >
        <Plus className="w-4 h-4" /> Add Setup / Trade Plan
      </button>
    </div>
  )
}
