import { createClient } from '@/lib/supabase/server'
import SharedDayView from './SharedDayView'
import type { Trade, TradingDay } from '@/lib/supabase/types'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Shared session — TapeScore' }

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = await createClient()
  // Token-gated read (SECURITY DEFINER RPC) — returns only this day's data, or
  // null when the token is invalid / revoked / expired. anon-callable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any
  const { data } = await db.rpc('get_shared_day', { p_token: token })

  const day = (data?.day ?? null) as TradingDay | null
  const trades = (data?.trades ?? []) as Trade[]

  if (!data || !day) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/tapescore-mark.svg" alt="TapeScore" className="h-10 w-10 mx-auto mb-4" />
          <h1 className="text-lg font-semibold text-white">This link isn&apos;t available</h1>
          <p className="text-gray-400 text-sm mt-2">
            The review link is invalid, has expired, or was revoked. Ask the trader for a fresh one.
          </p>
        </div>
      </div>
    )
  }

  return <SharedDayView day={day} trades={trades} />
}
