'use client'

import type { TradeTag, TradeTags, TagCategory } from '@/lib/supabase/types'
import { normalizeTagArray } from '@/lib/supabase/types'

interface Props {
  tags: TradeTag[]
  selected: TradeTags
  suggested?: TradeTags
  onChange: (tags: TradeTags) => void
}

const CATEGORY_LABELS: Record<TagCategory, string> = {
  setups: 'Setup',
  confluences: 'Confluences',
  order_flow: 'Order Flow',
  entry_model: 'Entry Model',
  trade_management: 'Management',
  day_type: 'Day Type',
  mistakes: 'Mistakes',
  emotions: 'Emotions',
}

const CATEGORY_COLORS: Partial<Record<TagCategory, string>> = {
  mistakes: 'bg-red-700 border-red-600 text-white',
  emotions: 'bg-purple-700 border-purple-600 text-white',
}

const DEFAULT_SELECTED = 'bg-blue-700 border-blue-600 text-white'

// Mistakes + emotions hidden pending a new tagging system. Historical tag
// data on existing trades stays in the DB (tags_json.mistakes / .emotions)
// and is preserved so a future migration can fold it into the replacement.
// To re-expose them temporarily, re-add 'mistakes' and 'emotions' here.
const CATEGORY_ORDER: TagCategory[] = [
  'setups',
  'confluences',
  'order_flow',
  'entry_model',
  'trade_management',
  'day_type',
]

export default function TagSelector({ tags, selected, suggested, onChange }: Props) {
  const byCategory = tags.reduce((acc, tag) => {
    if (!acc[tag.category]) acc[tag.category] = []
    acc[tag.category].push(tag)
    return acc
  }, {} as Record<TagCategory, TradeTag[]>)

  const toggle = (tag: TradeTag) => {
    const cat = tag.category
    // Normalize: tolerate legacy single-string day_type values from old rows
    const arr = normalizeTagArray(selected[cat])
    const next = arr.includes(tag.label) ? arr.filter(l => l !== tag.label) : [...arr, tag.label]
    onChange({ ...selected, [cat]: next.length > 0 ? next : undefined })
  }

  const isSelected = (tag: TradeTag): boolean => {
    return normalizeTagArray(selected[tag.category]).includes(tag.label)
  }

  const isSuggested = (tag: TradeTag): boolean => {
    if (!suggested) return false
    return normalizeTagArray(suggested[tag.category]).includes(tag.label)
  }

  const categories = CATEGORY_ORDER.filter(cat => byCategory[cat]?.length > 0)

  return (
    <div className="space-y-4">
      {categories.map(cat => (
        <div key={cat}>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            {CATEGORY_LABELS[cat] ?? cat}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {byCategory[cat].map(tag => {
              const sel = isSelected(tag)
              const sug = isSuggested(tag)
              return (
                <button key={tag.id} type="button" onClick={() => toggle(tag)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    sel
                      ? (CATEGORY_COLORS[cat] ?? DEFAULT_SELECTED)
                      : sug
                        ? 'bg-yellow-900/20 border-dashed border-yellow-600 text-yellow-400 hover:bg-yellow-900/40'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                  }`}
                >
                  {sug && !sel ? '+ ' : ''}{tag.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
