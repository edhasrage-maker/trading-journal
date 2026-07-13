'use client'

/**
 * UI density mode — Beginner (default) vs Pro. See docs/BEGINNER_PRO_MODES.md.
 * Beginner is a plain-English presentation layer over the same engine; Pro is
 * the full instrument.
 *
 * Persistence (Pt 17): the mode is stored PER-USER server-side in
 * `trader_profile.onboarding_json.ui_mode` (via /api/onboarding), so it follows
 * the trader across tabs and devices instead of desyncing per-browser.
 * localStorage stays as the OPTIMISTIC/offline layer — it paints the returning
 * user's last choice instantly (no first-render flash), and the server value
 * reconciles it once fetched. Default stays 'beginner' (Highlights) for new
 * accounts.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type UiMode = 'beginner' | 'pro'

const STORAGE_KEY = 'tapescore-ui-mode'

function isUiMode(v: unknown): v is UiMode {
  return v === 'beginner' || v === 'pro'
}

const UiModeContext = createContext<{ mode: UiMode; setMode: (m: UiMode) => void }>({
  mode: 'beginner',
  setMode: () => {},
})

export function UiModeProvider({ children }: { children: React.ReactNode }) {
  // Default 'beginner' on first paint (SSR-safe); hydrate the saved choice after
  // mount so SSR and the initial client render match.
  const [mode, setModeState] = useState<UiMode>('beginner')
  // True once the user has actively toggled the mode this session — guards the
  // async server hydration from clobbering a fresh manual choice if the GET
  // resolves after the user has already flipped it.
  const userChangedRef = useRef(false)

  useEffect(() => {
    // 1. Optimistic paint from localStorage (instant, no flash for returners).
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage
    if (isUiMode(stored)) setModeState(stored)

    // 2. Server is the source of truth (cross-device). Reconcile once, unless the
    //    user has already changed the mode manually while this was in flight.
    let cancelled = false
    fetch('/api/onboarding')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { onboarding?: { ui_mode?: unknown } } | null) => {
        if (cancelled || userChangedRef.current) return
        const serverMode = d?.onboarding?.ui_mode
        if (isUiMode(serverMode)) {
          setModeState(serverMode)
          try { window.localStorage.setItem(STORAGE_KEY, serverMode) } catch { /* storage unavailable */ }
        }
      })
      .catch(() => { /* offline / not migrated → localStorage value stands */ })
    return () => { cancelled = true }
  }, [])

  const setMode = useCallback((m: UiMode) => {
    userChangedRef.current = true
    setModeState(m)
    // Optimistic local write first so the choice survives a reload even if the
    // network write fails.
    try { window.localStorage.setItem(STORAGE_KEY, m) } catch { /* storage unavailable — session-only */ }
    // Best-effort server persist (fire-and-forget). Shallow-merges into
    // onboarding_json, so it never clobbers sibling keys; a failure (offline,
    // demo read-only account, or un-migrated columns) just leaves the localStorage
    // value in place.
    void fetch('/api/onboarding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding: { ui_mode: m } }),
    }).catch(() => { /* non-fatal */ })
  }, [])

  return <UiModeContext.Provider value={{ mode, setMode }}>{children}</UiModeContext.Provider>
}

export function useUiMode() {
  return useContext(UiModeContext)
}
