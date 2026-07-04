'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Desktop sidebar collapsed/expanded state, shared so the sidebar (rail width)
 * and the main content pane (left margin) move in lockstep — collapsing the
 * sidebar RECLAIMS the space for content instead of leaving a gap. Persisted in
 * localStorage; live-synced across subscribers via a custom window event (same
 * pattern as useMfeUnit / useUiMode — no provider needed). Desktop-only; mobile
 * uses the bottom tab bar and ignores this.
 */

const KEY = 'sidebar-collapsed-v1'
const EVENT = 'sidebar-collapsed:changed'

export function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage on mount (SSR-safe default is expanded)
    try { setCollapsed(localStorage.getItem(KEY) === '1') } catch { /* ignore */ }
    const onCustom = (e: Event) => setCollapsed(!!(e as CustomEvent<boolean>).detail)
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setCollapsed(e.newValue === '1') }
    window.addEventListener(EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const set = useCallback((v: boolean) => {
    setCollapsed(v)
    try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: v }))
  }, [])

  return [collapsed, set]
}
