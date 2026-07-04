'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Eye, Loader2 } from 'lucide-react'

/**
 * Slim sticky bar shown across the app when the read-only demo account is
 * signed in. Makes the "you're in a demo" state obvious and gives a one-click
 * path to sign out and create a real account. Rendered only when the layout
 * detects the demo user (server-side), so it never flashes for real users.
 */
export default function DemoBanner() {
  const [loading, setLoading] = useState(false)

  const exit = async () => {
    setLoading(true)
    try {
      await createClient().auth.signOut()
    } finally {
      window.location.href = '/'
    }
  }

  return (
    <div className="sticky top-0 z-40 flex items-center justify-center gap-3 bg-amber-500/95 px-4 py-1.5 text-center text-[13px] font-medium text-gray-950 backdrop-blur">
      <Eye className="hidden h-4 w-4 shrink-0 sm:block" />
      <span>
        You&apos;re exploring the <strong>demo</strong> — changes won&apos;t be saved.
      </span>
      <button
        onClick={exit}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-md bg-gray-950 px-2.5 py-1 text-xs font-semibold text-amber-400 transition-colors hover:bg-gray-800 disabled:opacity-60"
      >
        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
        Sign up free
      </button>
    </div>
  )
}
