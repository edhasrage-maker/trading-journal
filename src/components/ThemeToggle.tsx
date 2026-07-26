'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

/**
 * Ground switch — carbon (default) ↔ chartbook light.
 *
 * The theme is a single `data-theme` attribute on <html>; every colour in the
 * app resolves through the Tailwind ramp variables, so flipping that attribute
 * re-skins the whole surface with no component involvement (see globals.css).
 *
 * The attribute is ALSO set by a blocking script in the document head, before
 * first paint — without it a light-mode user gets a carbon flash on every
 * navigation. This component only mirrors that state into React and writes the
 * choice back; it must never be the thing that first applies the theme.
 */

export const THEME_KEY = 'ts-theme'
export type Theme = 'dark' | 'light'

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>('dark')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme')
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the value the head script already applied
    if (current === 'light') setTheme('light')
    setMounted(true)
  }, [])

  const apply = (next: Theme) => {
    setTheme(next)
    const root = document.documentElement
    if (next === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
    try { localStorage.setItem(THEME_KEY, next) } catch { /* ignore */ }
  }

  // Render the icon only after mount: server-rendered markup can't know the
  // stored theme, and guessing produces a hydration mismatch.
  const next: Theme = theme === 'light' ? 'dark' : 'light'
  const Icon = theme === 'light' ? Moon : Sun

  return (
    <button
      type="button"
      onClick={() => apply(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={
        compact
          ? 'p-1.5 rounded text-gray-500 hover:text-gray-200 transition-colors'
          : 'p-1.5 rounded text-gray-500 hover:text-gray-200 transition-colors'
      }
    >
      {mounted ? <Icon className="w-4 h-4" /> : <span className="block w-4 h-4" />}
    </button>
  )
}
