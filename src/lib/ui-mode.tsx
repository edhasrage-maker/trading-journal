'use client'

/**
 * UI density mode — Beginner (default) vs Pro. See docs/BEGINNER_PRO_MODES.md.
 * Beginner is a plain-English presentation layer over the same engine; Pro is
 * the full instrument. Persisted per-browser in localStorage for v1 (a
 * per-user setting can back this later for cross-device).
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type UiMode = 'beginner' | 'pro'

const STORAGE_KEY = 'tapescore-ui-mode'

const UiModeContext = createContext<{ mode: UiMode; setMode: (m: UiMode) => void }>({
  mode: 'beginner',
  setMode: () => {},
})

export function UiModeProvider({ children }: { children: React.ReactNode }) {
  // Default 'beginner' on first paint (SSR-safe); hydrate the saved choice after
  // mount so SSR and the initial client render match.
  const [mode, setModeState] = useState<UiMode>('beginner')
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage
    if (stored === 'pro' || stored === 'beginner') setModeState(stored)
  }, [])

  const setMode = useCallback((m: UiMode) => {
    setModeState(m)
    try { window.localStorage.setItem(STORAGE_KEY, m) } catch { /* storage unavailable — session-only */ }
  }, [])

  return <UiModeContext.Provider value={{ mode, setMode }}>{children}</UiModeContext.Provider>
}

export function useUiMode() {
  return useContext(UiModeContext)
}
