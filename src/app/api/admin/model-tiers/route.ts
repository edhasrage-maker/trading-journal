/**
 * Admin-only model-tier management (public/multi-tenant build).
 *
 *   GET  → list every user (email + current tier).
 *   POST → { user_id, tier } set a user's tier ('basic' | 'opus').
 *
 * Auth: the caller must be the app admin (ADMIN_EMAIL / local owner). Writing
 * ANOTHER user's tier needs to bypass owner-RLS, so this route uses the
 * service-role client — the ONLY write path for `ai_model_grants`. Cloud-only:
 * the service key is unset locally, so it 404s in the local build (where the
 * owner is already Opus by admin resolution and needs no toggle).
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient, isServiceConfigured } from '@/lib/supabase/service'
import { isAdminUser } from '@/lib/ai-model'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

async function requireAdmin(): Promise<NextResponse | null> {
  if (!isServiceConfigured()) {
    return NextResponse.json({ error: 'Not available in this deployment.' }, { status: 404 })
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  if (!isAdminUser(user)) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  return null
}

export async function GET() {
  const denied = await requireAdmin(); if (denied) return denied
  try {
    const svc: AnyClient = createServiceClient()
    const { data: grantRows } = await svc.from('ai_model_grants').select('user_id, tier')
    const tierByUser = new Map<string, string>(
      (grantRows ?? []).map((g: { user_id: string; tier: string }) => [g.user_id, g.tier]),
    )

    // Enumerate auth users (one page is plenty for the current tester cohort).
    const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const users = (data?.users ?? []).map((u: { id: string; email?: string | null; created_at?: string }) => ({
      id: u.id,
      email: u.email ?? '(no email)',
      created_at: u.created_at ?? null,
      tier: tierByUser.get(u.id) ?? 'basic',
    })).sort((a: { email: string }, b: { email: string }) => a.email.localeCompare(b.email))

    return NextResponse.json({ users, adminEmail: process.env.ADMIN_EMAIL ?? null })
  } catch (e) {
    console.error('[admin/model-tiers] GET failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin(); if (denied) return denied

  let body: { user_id?: string; tier?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const userId = typeof body.user_id === 'string' ? body.user_id : ''
  const tier = body.tier
  if (!userId) return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  if (tier !== 'basic' && tier !== 'opus') return NextResponse.json({ error: "tier must be 'basic' or 'opus'" }, { status: 400 })

  try {
    const svc: AnyClient = createServiceClient()
    const { error } = await svc
      .from('ai_model_grants')
      .upsert({ user_id: userId, tier, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, user_id: userId, tier })
  } catch (e) {
    console.error('[admin/model-tiers] POST failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 })
  }
}
