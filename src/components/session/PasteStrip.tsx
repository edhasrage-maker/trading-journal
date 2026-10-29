'use client'

import { useRef, useState } from 'react'
import { ClipboardList, Pencil } from 'lucide-react'

/**
 * The Session page's add-a-trade strip (mockup: SessionOnePage / SessionLive).
 * One row: paste or drop a chart screenshot and TapeScore reads the trade, or
 * type it in. Ctrl+V is caught by the page's document listener; this card adds
 * drop and click-to-pick (a <label> over a hidden file input, so a tap opens
 * the photo library on a phone). `roomy` = the taller live version.
 */
export default function PasteStrip({
  roomy = false, onFile, onManual,
}: {
  roomy?: boolean
  onFile: (file: File) => void
  onManual: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const takeImage = (files: FileList | null | undefined) => {
    const file = Array.from(files ?? []).find(f => f.type.startsWith('image/'))
    if (file) onFile(file)
  }

  return (
    <section
      aria-label="Add a trade"
      onDragOver={e => { e.preventDefault(); if (!dragging) setDragging(true) }}
      onDragLeave={e => { e.preventDefault(); setDragging(false) }}
      onDrop={e => { e.preventDefault(); setDragging(false); takeImage(e.dataTransfer?.files) }}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border-[1.5px] border-dashed transition-colors ${
        roomy ? 'px-5 py-[18px]' : 'px-4 py-3'
      } ${dragging ? 'border-blue-500 bg-blue-500/10' : 'border-gray-600 bg-gray-800/20'}`}
    >
      <label className="flex-1 min-w-[240px] flex items-center gap-3 cursor-pointer group">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => { takeImage(e.target.files); e.currentTarget.value = '' }}
        />
        <ClipboardList className={`shrink-0 text-gray-400 group-hover:text-gray-200 ${roomy ? 'w-8 h-8' : 'w-6 h-6'}`} aria-hidden="true" />
        <span className="min-w-0">
          <span className={`font-semibold text-gray-100 ${roomy ? 'text-[15px] block' : 'text-sm'}`} style={{ fontFamily: 'var(--font-display)' }}>
            Paste your chart — TapeScore reads the trade
          </span>
          <span className={`text-xs text-gray-500 ${roomy ? 'block' : ''}`}>
            {roomy ? (
              <>
                <span className="hidden sm:inline">Ctrl + V a screenshot of your position, or drop an image.</span>
                <span className="sm:hidden">Tap to add a screenshot.</span>
              </>
            ) : (
              <span className="hidden sm:inline"> · Ctrl + V a screenshot, or drop an image</span>
            )}
          </span>
        </span>
      </label>
      <button
        type="button"
        onClick={onManual}
        className="shrink-0 inline-flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 text-gray-200 text-xs font-medium rounded-md px-3 min-h-9 transition-colors"
      >
        <Pencil className="w-3.5 h-3.5 text-gray-400" />
        Add a trade manually
      </button>
    </section>
  )
}
