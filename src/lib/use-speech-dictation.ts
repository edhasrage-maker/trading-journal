'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * Browser speech-to-text (Web Speech API) as a small hook — no backend, no
 * per-minute cost, recognition runs in the browser. Chrome/Edge support it;
 * Firefox and older Safari don't, so `supported` is false there and callers
 * (MicButton) render nothing rather than a dead mic.
 *
 * Emits FINALIZED phrases (after a natural pause) via onFinalText; the caller
 * appends them to whatever field it owns. Toggle-based: click to start, click
 * again (or a browser silence-timeout) to stop.
 */

// The Web Speech API isn't in lib.dom for every TS target, so type only the
// sliver we touch instead of pulling in extra @types.
interface SpeechAlt { transcript: string }
interface SpeechResult { isFinal: boolean; 0: SpeechAlt }
interface SpeechResultList { readonly length: number; [i: number]: SpeechResult }
interface SpeechResultEvent { resultIndex: number; results: SpeechResultList }
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechResultEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

function getCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useSpeechDictation(onFinalText: (text: string) => void) {
  // SSR-safe capability detection: false on the server and during hydration,
  // real check on the client — no setState-in-effect, no hydration mismatch.
  const supported = useSyncExternalStore(() => () => {}, () => getCtor() != null, () => false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<Recognition | null>(null)
  const onTextRef = useRef(onFinalText)
  // Keep the latest callback fresh without re-creating start(); updated
  // post-render (writing a ref during render trips the react-compiler rule).
  useEffect(() => { onTextRef.current = onFinalText }, [onFinalText])

  const stop = useCallback(() => { recRef.current?.stop() }, [])

  const start = useCallback(() => {
    const Ctor = getCtor()
    if (!Ctor || recRef.current) return
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = false // commit finalized phrases only — simplest robust UX
    rec.onresult = e => {
      let finalText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript
      }
      const t = finalText.trim()
      if (t) onTextRef.current(t)
    }
    rec.onerror = ev => {
      // no-speech is a benign silence timeout, not a real error.
      setError(
        ev.error === 'not-allowed' || ev.error === 'service-not-allowed'
          ? 'Microphone blocked — allow mic access for this site.'
          : ev.error === 'no-speech' ? null : ev.error,
      )
      setListening(false)
      recRef.current = null
    }
    rec.onend = () => { setListening(false); recRef.current = null }
    setError(null)
    recRef.current = rec
    setListening(true)
    try { rec.start() } catch { setListening(false); recRef.current = null }
  }, [])

  const toggle = useCallback(() => {
    if (recRef.current) stop()
    else start()
  }, [start, stop])

  // Abort any in-flight recognition on unmount.
  useEffect(() => () => { recRef.current?.abort(); recRef.current = null }, [])

  return { supported, listening, error, toggle }
}
