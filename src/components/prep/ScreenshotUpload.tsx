'use client'

import { useCallback, useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'

interface Props {
  value: string | null
  onChange: (url: string | null, file?: File) => void
  label?: string
}

export default function ScreenshotUpload({ value, onChange, label = 'Chart Screenshot' }: Props) {
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<string | null>(value)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    setPreview(url)
    onChange(url, file)
  }, [onChange])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    if (item) {
      const file = item.getAsFile()
      if (file) handleFile(file)
    }
  }, [handleFile])

  const clear = () => {
    setPreview(null)
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="space-y-2">
      {label && <label className="block text-sm font-medium text-gray-300">{label}</label>}

      {preview ? (
        <div className="relative rounded-xl overflow-hidden border border-gray-700 group">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Chart screenshot" className="w-full object-contain max-h-80 bg-gray-900" />
          <button
            onClick={clear}
            className="absolute top-2 right-2 bg-gray-900/80 hover:bg-red-900 text-white rounded-lg p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div
          onDrop={onDrop}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onPaste={onPaste}
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer transition-colors outline-none focus:ring-2 focus:ring-blue-600
            ${dragging ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700 hover:border-gray-500 bg-gray-900/50'}`}
        >
          <ImagePlus className="w-8 h-8 text-gray-500" />
          <div className="text-center">
            <p className="text-sm text-gray-300">Drop, paste, or click to upload</p>
            <p className="text-xs text-gray-500 mt-1">PNG, JPG, WebP</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          />
        </div>
      )}
    </div>
  )
}
