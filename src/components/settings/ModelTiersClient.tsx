'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertCircle, ShieldCheck, Sparkles } from 'lucide-react'

interface UserRow {
  id: string
  email: string
  created_at: string | null
  tier: 'basic' | 'opus'
}

export default function ModelTiersClient() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [adminEmail, setAdminEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/model-tiers')
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to load users'); return }
      setUsers(data.users ?? [])
      setAdminEmail(data.adminEmail ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load from the admin API on mount
  useEffect(() => { void load() }, [load])

  const setTier = async (u: UserRow, tier: 'basic' | 'opus') => {
    if (u.tier === tier) return
    setSavingId(u.id)
    setError(null)
    // Optimistic — revert on failure.
    setUsers(prev => prev.map(x => x.id === u.id ? { ...x, tier } : x))
    try {
      const res = await fetch('/api/admin/model-tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: u.id, tier }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error ?? 'Save failed')
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, tier: u.tier } : x))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, tier: u.tier } : x))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white text-sm">User model tiers</h2>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading users…
        </div>
      ) : users.length === 0 ? (
        <p className="text-sm text-gray-500 py-4">No users found.</p>
      ) : (
        <div className="divide-y divide-gray-800">
          {users.map(u => {
            const isAdmin = !!adminEmail && u.email === adminEmail
            return (
              <div key={u.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-200 truncate">{u.email}</span>
                    {isAdmin && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-300/80 border border-emerald-800/50 rounded px-1.5 py-0.5">
                        <ShieldCheck className="w-3 h-3" /> Admin
                      </span>
                    )}
                  </div>
                </div>
                {isAdmin ? (
                  <span className="text-xs text-gray-500 pr-1">Premium (auto)</span>
                ) : (
                  <div className="inline-flex rounded-lg border border-gray-700 overflow-hidden text-xs">
                    {(['basic', 'opus'] as const).map(tier => {
                      const active = u.tier === tier
                      const label = tier === 'basic' ? 'Standard' : 'Premium'
                      return (
                        <button
                          key={tier}
                          type="button"
                          disabled={savingId === u.id}
                          onClick={() => void setTier(u, tier)}
                          className={
                            active
                              ? (tier === 'opus'
                                ? 'px-3 py-1.5 bg-amber-600 text-white font-medium'
                                : 'px-3 py-1.5 bg-gray-700 text-white font-medium')
                              : 'px-3 py-1.5 text-gray-400 hover:bg-gray-800 disabled:opacity-50'
                          }
                        >
                          {savingId === u.id && active ? <Loader2 className="w-3 h-3 animate-spin" /> : label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[11px] text-gray-600 pt-1">
        Tier resolves server-side across all AI features. Users never see the tier or model name.
      </p>
    </div>
  )
}
