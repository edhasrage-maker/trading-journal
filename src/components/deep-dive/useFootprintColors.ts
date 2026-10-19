'use client'

/**
 * The trader's footprint colours, per app theme (a colour picked for a white
 * chart rarely works on a dark one). Saved the way the Live chart saves its
 * appearance: this browser at once, and the account a second later, so the
 * other machine and the phone pick them up.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { pullChartPref, schedulePushChartPref, REPLAY_FP_COLORS_KEY } from '@/lib/chart-prefs'
import type { Theme } from '@/components/ThemeToggle'
import { fpDefaults, type FpColorKey, type FpColors } from './palette'

type Stored = Partial<Record<Theme, FpColors>>

const NONE: FpColors = {}
const isStored = (v: unknown): v is Stored => !!v && typeof v === 'object' && !Array.isArray(v)

export function useFootprintColors(theme: Theme) {
  const [stored, setStored] = useState<Stored>({})

  useEffect(() => {
    try {
      const raw = localStorage.getItem(REPLAY_FP_COLORS_KEY)
      const local = raw ? JSON.parse(raw) : null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage after mount (SSR has no storage)
      if (isStored(local)) setStored(local)
    } catch { /* storage unavailable: theme colours */ }
    let live = true
    pullChartPref(REPLAY_FP_COLORS_KEY).then(v => {
      if (!live || !isStored(v)) return
      setStored(v)
      try { localStorage.setItem(REPLAY_FP_COLORS_KEY, JSON.stringify(v)) } catch { /* not cached */ }
    })
    return () => { live = false }
  }, [])

  const save = useCallback((next: Stored) => {
    setStored(next)
    try { localStorage.setItem(REPLAY_FP_COLORS_KEY, JSON.stringify(next)) } catch { /* not cached */ }
    schedulePushChartPref(REPLAY_FP_COLORS_KEY, next)
  }, [])

  /** The picks for this theme (stable between renders, so the footprint only redraws on a change). */
  const mine = stored[theme] ?? NONE
  return useMemo(() => {
    const { outline, ...picks } = mine
    return {
      mine,
      /** What each picker shows: the pick, else the theme's own colour. */
      values: { ...fpDefaults(theme), ...picks } as Record<FpColorKey, string>,
      set: (k: FpColorKey, hex: string) => save({ ...stored, [theme]: { ...mine, [k]: hex } }),
      /** Candle outlines on / off. */
      outline: !!outline,
      setOutline: (on: boolean) => save({ ...stored, [theme]: { ...mine, outline: on } }),
      reset: () => save({ ...stored, [theme]: {} }),
    }
  }, [mine, stored, theme, save])
}
