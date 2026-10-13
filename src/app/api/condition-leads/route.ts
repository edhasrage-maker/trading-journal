import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { loadConditionData } from '@/lib/condition-lookup-refresh'
import { buildLeads } from '@/lib/condition-leads'
import type { MetricInputs } from '@/lib/condition-lookup'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { clientError } from '@/lib/api-error'
import { todayPT } from '@/lib/pt-time'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * POST /api/condition-leads
 * Body: { rvol?, dr_adr?, ib?, atr_730?, ib_atr? } — the five metrics of the
 * session being viewed, used only to say whether it falls inside each lead.
 *
 * Returns this quarter's Morning Conditions leads and how each has done since
 * the quarter began (see condition-leads.ts for why they are forward tests and
 * not findings). Computed on request from the same trades and context rows the
 * nightly rebuild reads — nothing is stored, so there is nothing to migrate and
 * nothing that can drift from the lookup.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<MetricInputs>
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const dayInputs: MetricInputs = {
      rvol: num(body.rvol), dr_adr: num(body.dr_adr), ib: num(body.ib),
      atr_730: num(body.atr_730), ib_atr: num(body.ib_atr),
    }

    const supabase: AnyClient = await createClient()
    let userId: string | null = null
    if (!LOCAL_FEATURES_ENABLED) {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 403 })
      userId = user.id
    }

    const data = await loadConditionData(supabase, userId)
    const anyInput = Object.values(dayInputs).some(v => v != null)
    const result = buildLeads(data, todayPT(), anyInput ? dayInputs : null)
    return NextResponse.json({ ...result, historyStart: data.historyStart })
  } catch (e) {
    const err = e as Error
    console.error('[condition-leads] failed:', err)
    return NextResponse.json({ error: clientError(err, 'unknown server error') }, { status: 500 })
  }
}
