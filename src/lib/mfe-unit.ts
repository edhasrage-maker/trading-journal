'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Shared MFE/MAE display unit state. Multiple surfaces (Dashboard card,
 * Intraday summary bar, EOD recap stats strip, per-trade Peak MFE/MAE) all
 * use the same unit so flipping it in one place updates the others.
 *
 * Persistence: localStorage (single-tab and reload-safe).
 * Cross-component live sync: custom 'mfe-unit:changed' event dispatched on
 * window — local subscribers re-render immediately without waiting for the
 * native 'storage' event (which only fires for OTHER tabs).
 */

export type MfeUnit = 'pts' | 'dollars' | 'atr'

export const MFE_UNIT_KEY = 'dashboard-stat-mfe-unit-v1'
export const MFE_UNIT_CHANGED_EVENT = 'mfe-unit:changed'

const isMfeUnit = (v: unknown): v is MfeUnit =>
  v === 'pts' || v === 'dollars' || v === 'atr'

/** Read the current unit synchronously from localStorage. Falls back to 'atr'. */
export function readMfeUnit(): MfeUnit {
  if (typeof window === 'undefined') return 'atr'
  try {
    const raw = localStorage.getItem(MFE_UNIT_KEY)
    return isMfeUnit(raw) ? raw : 'atr'
  } catch {
    return 'atr'
  }
}

/**
 * React hook for components that need the live MFE/MAE unit. Re-renders on
 * any change anywhere (same tab via custom event, other tabs via storage
 * event). Default is 'atr' to match the Dashboard's documented default.
 */
export function useMfeUnit(): [MfeUnit, (u: MfeUnit) => void] {
  const [unit, setUnitState] = useState<MfeUnit>('atr')

  useEffect(() => {
    // Hydrate from localStorage on mount (matches SSR-safe default).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration
    setUnitState(readMfeUnit())

    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<MfeUnit>).detail
      if (isMfeUnit(detail)) setUnitState(detail)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === MFE_UNIT_KEY && isMfeUnit(e.newValue)) setUnitState(e.newValue)
    }
    window.addEventListener(MFE_UNIT_CHANGED_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(MFE_UNIT_CHANGED_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setUnit = useCallback((u: MfeUnit) => {
    setUnitState(u)
    try { localStorage.setItem(MFE_UNIT_KEY, u) } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent<MfeUnit>(MFE_UNIT_CHANGED_EVENT, { detail: u }))
  }, [])

  return [unit, setUnit]
}

/**
 * Format a numeric MFE/MAE value in the active unit. Caller is responsible
 * for already having converted the underlying pts → dollars/ATR before
 * calling (this is just the display formatter).
 */
export function formatMfeMae(value: number | null, unit: MfeUnit): string {
  if (value == null) return '—'
  if (unit === 'dollars') {
    const abs = Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })
    return (value >= 0 ? '+$' : '-$') + abs
  }
  if (unit === 'atr') return (value >= 0 ? '+' : '') + value.toFixed(2) + '×'
  return (value >= 0 ? '+' : '') + value.toFixed(1)
}
