'use client'

import { useEffect, useRef } from 'react'

// Cloudflare Turnstile widget for signup/signin abuse protection.
//
// SAFE-BY-DEFAULT: renders nothing and never blocks unless
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is set at build time. So the auth form behaves
// exactly as it does today until CAPTCHA is provisioned. When the key is set,
// it renders the challenge and hands the parent a single-use token to pass as
// Supabase's `captchaToken` (Supabase enforces it once CAPTCHA is enabled in
// the dashboard; until then the token is simply ignored).
export const CAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TurnstileApi = any
declare global {
  var turnstile: TurnstileApi | undefined
}

let scriptPromise: Promise<void> | null = null
function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    document.head.appendChild(s)
  })
  return scriptPromise
}

/**
 * `resetSignal` — bump this number from the parent (e.g. after a submit) to
 * force a fresh challenge, since Turnstile tokens are single-use.
 */
export default function Turnstile({
  onToken,
  resetSignal = 0,
}: {
  onToken: (token: string | null) => void
  resetSignal?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  // Latest-ref for the callback so the render-once effect never re-runs.
  const cb = useRef(onToken)
  useEffect(() => { cb.current = onToken }, [onToken])

  useEffect(() => {
    if (!CAPTCHA_SITE_KEY) return
    let cancelled = false
    loadTurnstileScript().then(() => {
      if (cancelled || !ref.current || !window.turnstile) return
      widgetId.current = window.turnstile.render(ref.current, {
        sitekey: CAPTCHA_SITE_KEY,
        callback: (token: string) => cb.current(token),
        'expired-callback': () => cb.current(null),
        'error-callback': () => cb.current(null),
      })
    })
    return () => {
      cancelled = true
      if (widgetId.current != null && window.turnstile) {
        try { window.turnstile.remove(widgetId.current) } catch { /* widget already gone */ }
        widgetId.current = null
      }
    }
  }, [])

  // Reset the widget when the parent bumps resetSignal (token was consumed).
  useEffect(() => {
    if (!CAPTCHA_SITE_KEY || resetSignal === 0) return
    if (widgetId.current != null && window.turnstile) {
      try { window.turnstile.reset(widgetId.current) } catch { /* not rendered yet */ }
      cb.current(null)
    }
  }, [resetSignal])

  if (!CAPTCHA_SITE_KEY) return null
  return <div ref={ref} className="mt-3 flex justify-center" />
}
