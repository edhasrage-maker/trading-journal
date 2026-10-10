'use client'

import { useSyncExternalStore } from 'react'
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

// The attribute is the live truth, watched rather than read once: ThemeKeeper
// repairs a dropped attribute on navigation, and a second switch (Deep Dive's
// toolbar) can flip it, so every reader updates the moment it changes.
function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => mo.disconnect()
}
const snapshot = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')

/** The current app theme. 'dark' on the server and during hydration, so there
 *  is no mismatch; it settles to the applied theme right after. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, snapshot, () => 'dark')
}

/** Switch the app theme and remember it. */
export function applyTheme(next: Theme) {
  const root = document.documentElement
  if (next === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  try { localStorage.setItem(THEME_KEY, next) } catch { /* ignore */ }
}

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useTheme()
  const next: Theme = theme === 'light' ? 'dark' : 'light'
  const Icon = theme === 'light' ? Moon : Sun

  return (
    <button
      type="button"
      onClick={() => applyTheme(next)}
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
