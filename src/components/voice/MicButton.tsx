'use client'

import { Mic } from 'lucide-react'
import { useSpeechDictation } from '@/lib/use-speech-dictation'

/**
 * Dictation mic — click to speak text into a field; click again to stop.
 * Renders NOTHING where the browser has no Web Speech API (Firefox / older
 * Safari), so there's never a dead button. Finalized phrases are appended to
 * the caller via onText (the caller decides how to merge them into its field).
 */
export default function MicButton({
  onText,
  className,
  title = 'Dictate',
}: {
  onText: (text: string) => void
  className?: string
  title?: string
}) {
  const { supported, listening, toggle, error } = useSpeechDictation(onText)
  if (!supported) return null
  return (
    <button
      type="button"
      onClick={toggle}
      title={error ?? (listening ? 'Stop dictation' : `${title} — speak to type`)}
      aria-label={listening ? 'Stop dictation' : 'Start dictation'}
      className={`inline-flex items-center justify-center shrink-0 transition-colors ${
        listening ? 'text-red-400 animate-pulse' : error ? 'text-amber-500' : 'text-gray-500 hover:text-gray-200'
      } ${className ?? ''}`}
    >
      <Mic className="w-4 h-4" />
    </button>
  )
}
