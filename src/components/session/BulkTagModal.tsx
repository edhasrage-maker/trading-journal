'use client'

import { useState } from 'react'
import { Loader2, Tag, X } from 'lucide-react'
import TagSelector from '@/components/intraday/TagSelector'
import type { TradeTag, TradeTags } from '@/lib/supabase/types'

/**
 * Modal for applying tags to N selected trades at once. Starts with empty
 * selection (we don't know which tags are shared across the picked trades —
 * keeping it empty makes the action explicitly "add THESE tags"). Disabled
 * until at least one tag is chosen. Always additive — never replaces tags
 * already on the target trades.
 */
export default function BulkTagModal({
  count, allTags, applying, onCancel, onApply,
}: {
  count: number
  allTags: TradeTag[]
  applying: boolean
  onCancel: () => void
  onApply: (tags: TradeTags) => void
}) {
  const [picked, setPicked] = useState<TradeTags>({})
  const tagCount = Object.values(picked).reduce(
    (n, v) => n + (Array.isArray(v) ? v.length : v ? 1 : 0),
    0,
  )
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">Add tags to {count} trade{count === 1 ? '' : 's'}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Pick the tags to add. Existing tags on each trade are preserved.</p>
          </div>
          <button type="button" onClick={onCancel} className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-y-auto p-4 flex-1">
          <TagSelector tags={allTags} selected={picked} onChange={setPicked} />
        </div>
        <div className="flex items-center justify-between p-4 border-t border-gray-800 gap-3">
          <span className="text-xs text-gray-500">{tagCount} tag{tagCount === 1 ? '' : 's'} picked</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onApply(picked)}
              disabled={tagCount === 0 || applying}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
              {applying ? 'Applying…' : `Apply to ${count}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
