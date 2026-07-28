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
  // Starts 'dark' on BOTH server and first client render, so there is no
  // hydration mismatch; the effect below corrects it to whatever the head
  // script already applied. The control is therefore always painted — an
  // earlier version withheld the icon until mount and simply looked missing.
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    // Read the SAVED choice, not the current attribute. ThemeKeeper repairs a
    // dropped attribute on navigation, and reading the DOM here would race it —
    // the icon would show "Light" on a page that is about to become light.
    let saved: string | null = null
    try { saved = localStorage.getItem(THEME_KEY) } catch { /* private mode / blocked */ }
    const current = saved ?? document.documentElement.getAttribute('data-theme')
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reflect the already-applied theme
    if (current === 'light') setTheme('light')
  }, [])

  const apply = (next: Theme) => {
    setTheme(next)
    const root = document.documentElement
    if (next === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
    try { localStorage.setItem(THEME_KEY, next) } catch { /* ignore */ }
  }

  const next: Theme = theme === 'light' ? 'dark' : 'light'
  const Icon = theme === 'light' ? Moon : Sun

  return (
    <button
      type="button"
      onClick={() => apply(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      // Matches the sibling masthead links (Import / Account) rather than
      // sitting a step dimmer, and carries a label on desktop: an unlabelled
      // 16px glyph in a row of words is easy to miss entirely.
      className="flex items-center gap-1.5 text-[13px] text-gray-400 hover:text-gray-100 transition-colors"
    >
      <Icon className="w-[15px] h-[15px]" />
      {!compact && <span>{theme === 'light' ? 'Dark' : 'Light'}</span>}
    </button>
  )
}
