'use client'

/**
 * "Your layout" in Chart Settings: Save layout puts the chart setup on the
 * account (chart_prefs, REPLAY_LAYOUT_KEY); Reset goes back to it.
 *
 * Changes still apply at once and stay in this browser as before — they reach
 * the account only when the trader presses Save layout. Opening Replay Review
 * applies the saved layout when it is newer than the one this browser last
 * took (a save made on the other machine or the phone); otherwise this
 * browser's own unsaved changes stay, and the panel says so. Chart sizes and
 * the Chart Settings switch are never part of it (per device).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pullChartPref, saveChartPref, REPLAY_LAYOUT_KEY } from '@/lib/chart-prefs'
import { DEFAULTS, cleanLayout, layoutOf, sameLayout, withLayout, type ReplayLayout, type ReplaySettings } from './replay-settings'

/** The save this browser's settings last took from the account (its savedAt). */
const BASE_KEY = 'replay-layout-base-v1'

interface Stored { v: 1; savedAt: string; layout: Partial<ReplayLayout> }
const isStored = (x: unknown): x is Stored =>
  !!x && typeof x === 'object' && typeof (x as Stored).savedAt === 'string' && !!(x as Stored).layout && typeof (x as Stored).layout === 'object'

export type LayoutState = {
  /** loading: the account hasn't answered yet · defaults: nothing saved and nothing changed */
  status: 'loading' | 'saved' | 'changed' | 'defaults'
  saving: boolean
  error: boolean
  save: () => void
  reset: () => void
}

export function useReplayLayout(settings: ReplaySettings, apply: (l: Partial<ReplayLayout>) => void): LayoutState {
  // undefined = still asking the account; null = nothing saved there
  const [saved, setSaved] = useState<{ savedAt: string; layout: ReplayLayout } | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const applyRef = useRef(apply)
  useEffect(() => { applyRef.current = apply }, [apply])

  useEffect(() => {
    let live = true
    pullChartPref(REPLAY_LAYOUT_KEY).then(v => {
      if (!live) return
      if (!isStored(v)) { setSaved(null); return }
      const layout = layoutOf(withLayout(DEFAULTS, cleanLayout(v.layout)))
      setSaved({ savedAt: v.savedAt, layout })
      let base: string | null = null
      try { base = localStorage.getItem(BASE_KEY) } catch { /* storage unavailable */ }
      if (base !== v.savedAt) {
        applyRef.current(layout)
        try { localStorage.setItem(BASE_KEY, v.savedAt) } catch { /* not remembered */ }
      }
    })
    return () => { live = false }
  }, [])

  const mine = useMemo(() => layoutOf(settings), [settings])
  const save = useCallback(() => {
    const value: Stored = { v: 1, savedAt: new Date().toISOString(), layout: mine }
    setSaving(true); setError(false)
    saveChartPref(REPLAY_LAYOUT_KEY, value).then(ok => {
      setSaving(false)
      if (!ok) { setError(true); return }
      setSaved({ savedAt: value.savedAt, layout: mine })
      try { localStorage.setItem(BASE_KEY, value.savedAt) } catch { /* not remembered */ }
    })
  }, [mine])
  const reset = useCallback(() => { apply(saved?.layout ?? layoutOf(DEFAULTS)) }, [apply, saved])

  const status: LayoutState['status'] = saved === undefined ? 'loading'
    : !sameLayout(mine, saved?.layout ?? layoutOf(DEFAULTS)) ? 'changed'
    : saved ? 'saved' : 'defaults'
  return { status, saving, error, save, reset }
}
