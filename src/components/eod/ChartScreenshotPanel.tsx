'use client'

import { forwardRef, useCallback, useRef, useState } from 'react'
import { ImagePlus, X, Loader2 } from 'lucide-react'

interface Props {
  chartUrl: string | null
  uploading: boolean
  onFile: (file: File) => void
  onRemove: () => void
  toolbar?: React.ReactNode
  children?: React.ReactNode
}

const ChartScreenshotPanel = forwardRef<HTMLDivElement, Props>(function ChartScreenshotPanel(
  { chartUrl, uploading, onFile, onRemove, toolbar, children },
  imageContainerRef,
) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) return
      onFile(file)
    },
    [onFile],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
      if (item) {
        const file = item.getAsFile()
        if (file) handleFile(file)
      }
    },
    [handleFile],
  )

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-300">EOD Chart</label>
        {toolbar}
      </div>

      {chartUrl ? (
        <div
          ref={imageContainerRef}
          className="relative rounded-lg overflow-hidden border border-gray-700 bg-gray-950 group"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={chartUrl}
            alt="EOD chart"
            className="w-full object-contain max-h-[640px] block select-none"
            draggable={false}
          />
          {children}
          <button
            onClick={onRemove}
            disabled={uploading}
            className="absolute top-2 right-2 bg-gray-900/80 hover:bg-red-900 text-white rounded-lg p-1.5 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30"
            title="Remove chart"
          >
            <X className="w-4 h-4" />
          </button>
          {uploading && (
            <div className="absolute inset-0 bg-gray-950/70 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
            </div>
          )}
        </div>
      ) : (
        <div
          onDrop={onDrop}
          onDragOver={e => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onPaste={onPaste}
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-12 flex flex-col items-center gap-3 cursor-pointer transition-colors outline-none focus:ring-2 focus:ring-blue-600
            ${dragging ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700 hover:border-gray-500 bg-gray-900/50'}`}
        >
          {uploading ? (
            <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
          ) : (
            <ImagePlus className="w-8 h-8 text-gray-500" />
          )}
          <div className="text-center">
            <p className="text-sm text-gray-300">
              {uploading ? 'Uploading...' : 'Drop, paste, or click to upload your EOD chart'}
            </p>
            <p className="text-xs text-gray-500 mt-1">PNG, JPG, WebP</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }}
          />
        </div>
      )}
    </div>
  )
})

export default ChartScreenshotPanel
