'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Mail, Loader2, Lock, Eye } from 'lucide-react'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import Turnstile, { CAPTCHA_SITE_KEY } from './Turnstile'

type Mode = 'magic' | 'password' | 'signup'

const redirectTo = () =>
  typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined

export default function AuthCard() {
  const [mode, setMode] = useState<Mode>('magic')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Turnstile CAPTCHA token (null until solved). Only meaningful when
  // NEXT_PUBLIC_TURNSTILE_SITE_KEY is set; otherwise stays null and is omitted.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [captchaReset, setCaptchaReset] = useState(0)
  const resetCaptcha = () => { setCaptchaToken(null); setCaptchaReset(n => n + 1) }

  const demo = async () => {
    setError(null); setLoading(true)
    try {
      const res = await fetch('/api/demo-login', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Demo is unavailable right now.')
      }
      window.location.href = '/dashboard'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo is unavailable right now.')
      setLoading(false)
    }
  }

  const oauth = async (provider: 'google' | 'discord') => {
    setError(null); setLoading(true)
    const { error } = await createClient().auth.signInWithOAuth({
      provider, options: { redirectTo: redirectTo() },
    })
    if (error) { setError(error.message); setLoading(false) }
    // On success the browser redirects to the provider — nothing else to do.
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setMsg(null); setLoading(true)
    const sb = createClient()
    // Only send a captcha token when CAPTCHA is provisioned; undefined is a no-op.
    const captcha = CAPTCHA_SITE_KEY ? (captchaToken ?? undefined) : undefined
    try {
      if (mode === 'magic') {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo(), captchaToken: captcha } })
        if (error) throw error
        setSent(true)
      } else if (mode === 'password') {
        const { error } = await sb.auth.signInWithPassword({ email, password, options: { captchaToken: captcha } })
        if (error) throw error
        window.location.href = '/dashboard'
      } else {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo(), captchaToken: captcha } })
        if (error) throw error
        if (data.session) window.location.href = '/dashboard'      // email confirmation off → in immediately
        else setMsg('Account created — check your email to confirm, then sign in.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setLoading(false)
      resetCaptcha()   // tokens are single-use — force a fresh challenge for the next attempt
    }
  }

  if (sent) {
    return (
      <div className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-xl text-center">
        <Mail className="w-9 h-9 text-blue-400 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-white">Check your email</h2>
        <p className="text-gray-400 text-sm mt-2">
          Sign-in link sent to <span className="text-white">{email}</span>. Open it on this device to sign in.
        </p>
      </div>
    )
  }

  const oauthBtn = 'w-full inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800 text-gray-100 font-medium py-2.5 text-sm hover:bg-gray-750 hover:border-gray-600 transition-colors disabled:opacity-60'

  return (
    <div className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-xl">
      <h2 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>Get started free</h2>
      <p className="text-gray-400 text-sm mt-0.5">Enter your email to start reviewing your trading game.</p>

      {/* Explore the demo — one-click, no signup (hosted build only) */}
      {!LOCAL_FEATURES_ENABLED && (
        <>
          <button
            type="button" onClick={demo} disabled={loading}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-lg border border-amber-500/60 bg-amber-500/10 text-amber-300 font-semibold py-2.5 text-sm hover:bg-amber-500/20 transition-colors disabled:opacity-60"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
            Explore the demo — no signup
          </button>
          <div className="flex items-center gap-3 my-4">
            <div className="h-px flex-1 bg-gray-800" />
            <span className="text-[11px] uppercase tracking-wide text-gray-600">or sign up</span>
            <div className="h-px flex-1 bg-gray-800" />
          </div>
        </>
      )}

      {/* Social */}
      <div className="mt-4 space-y-2">
        <button type="button" onClick={() => oauth('google')} disabled={loading} className={oauthBtn}>
          Continue with Google
        </button>
        <button type="button" onClick={() => oauth('discord')} disabled={loading} className={oauthBtn}>
          Continue with Discord
        </button>
      </div>

      <div className="flex items-center gap-3 my-4">
        <div className="h-px flex-1 bg-gray-800" />
        <span className="text-[11px] uppercase tracking-wide text-gray-600">or with email</span>
        <div className="h-px flex-1 bg-gray-800" />
      </div>

      {/* Magic link vs password toggle */}
      <div className="flex items-center gap-1 bg-gray-950/60 border border-gray-800 rounded-lg p-1 mb-4">
        {([['magic', 'Email link'], ['password', 'Password']] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setError(null); setMsg(null) }}
            className={`flex-1 rounded-md py-1.5 text-xs transition-colors ${
              (mode === m || (m === 'password' && mode === 'signup'))
                ? 'bg-blue-600 text-gray-950 font-semibold' : 'text-gray-400 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="bg-red-950 border border-red-800 text-red-300 text-sm px-3 py-2 rounded-lg mb-3">{error}</div>}
      {msg && <div className="bg-green-950 border border-green-800 text-green-300 text-sm px-3 py-2 rounded-lg mb-3">{msg}</div>}

      <form onSubmit={submit} className="space-y-3">
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com" required autoComplete="email"
          className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
        {mode !== 'magic' && (
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder={mode === 'signup' ? 'Create a password (min 6 chars)' : 'Password'}
            required minLength={6} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        )}
        <Turnstile onToken={setCaptchaToken} resetSignal={captchaReset} />
        <button
          type="submit" disabled={loading || !email || (!!CAPTCHA_SITE_KEY && !captchaToken)}
          className="w-full inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-gray-950 font-semibold py-2.5 rounded-lg text-sm transition-colors"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : (mode === 'magic' ? <Mail className="w-4 h-4" /> : <Lock className="w-4 h-4" />)}
          {loading ? 'Working…' : mode === 'magic' ? 'Send sign-in link' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      {mode === 'password' && (
        <p className="text-xs text-gray-500 mt-3 text-center">
          New here? <button type="button" onClick={() => { setMode('signup'); setError(null) }} className="text-blue-400 hover:underline">Create an account</button>
        </p>
      )}
      {mode === 'signup' && (
        <p className="text-xs text-gray-500 mt-3 text-center">
          Already have an account? <button type="button" onClick={() => { setMode('password'); setError(null) }} className="text-blue-400 hover:underline">Sign in</button>
        </p>
      )}

      <p className="text-[11px] text-gray-600 text-center mt-4">
        By continuing you agree to our{' '}
        <a href="/terms" className="text-gray-500 hover:text-gray-300 underline">Terms</a> and{' '}
        <a href="/privacy" className="text-gray-500 hover:text-gray-300 underline">Privacy Policy</a>.
      </p>
      <p className="text-[11px] text-gray-600 text-center mt-1">Early testing build · free while in beta</p>
    </div>
  )
}
