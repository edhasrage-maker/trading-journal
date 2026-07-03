/**
 * GET /api/ai-usage?action=coach_score
 *
 * Read-only view of the signed-in user's daily AI budget for an action, so the
 * UI can show "N left today" and disable a button when exhausted. Does NOT
 * increment — the consuming route does that via consumeAiUsage() at call time.
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { peekAiUsage, aiLimitFor } from '@/lib/ai-usage'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const action = new URL(req.url).searchParams.get('action') || 'coach_score'
  const result = await peekAiUsage(supabase, action, aiLimitFor(action))
  return NextResponse.json({ action, ...result })
}
