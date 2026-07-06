/**
 * Per-user daily AI usage caps (public/multi-tenant build).
 *
 * Backed by the `ai_usage` table + `consume_ai_usage` RPC (atomic
 * check-and-increment, keyed by user + PT calendar day + action). Use this to
 * gate any AI route so a free public tier can't run up unbounded model spend.
 *
 * Usage in a route:
 *   const gate = await consumeAiUsage(supabase, 'coach_score')
 *   if (!gate.allowed) return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
 *   // ... proceed with the AI call ...
 *
 * IMPORTANT: consume BEFORE the model call, and treat a click (one user action)
 * as one unit — not one model request. For the Coach Score that means one
 * "Grade with AI" click = 1, regardless of how many trades it grades.
 *
 * Fail-open: if the table/RPC hasn't been migrated yet (or the DB errors), the
 * gate ALLOWS the action (returns migrationPending) rather than hard-blocking a
 * working feature. Enforcement begins once the migration is applied.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Daily limits per action (per user, PT calendar day). Add a key to cap another
 *  AI surface. Big single-shot analyses are tighter; frequently auto-fired
 *  routes (summaries, themes, spell-check) are generous so a normal reviewing
 *  session never trips them — they exist to bound abuse, not to ration use. */
export const AI_LIMITS: Record<string, number> = {
  // Per-trade AI grade — one call grades ONE trade (the panel renders a button
  // per trade), and it's cheap (600 max tokens, and it skips the model entirely
  // when tags already cover every criterion). Generous so a normal multi-trade
  // review day never trips it. (NB: not the "3 clicks/day" batch design — this
  // route is per-trade.)
  coach_score: 25,
  // Coach chat is the heaviest route (180-day aggregates + 150 trades + up to 4
  // images re-sent every turn, streamed) — ~$0.03–0.09/call. 20/day still covers
  // a thorough back-and-forth while bounding the scripted-abuse ceiling to
  // ~$18–54/user/month worst case. The real cost lever is prompt-caching the
  // context block (stable within a conversation) — see project_storage_hardening
  // sibling note; caching cuts turns 2+ by ~90% regardless of this cap. The
  // Anthropic-workspace spend cap remains the hard $ backstop.
  coach_chat: 20,
  // Coaching-thread distiller — one small JSON call fired when a coach chat is
  // archived (idle/manual). Cheap (~1.2k out tokens, no images, no 180-day
  // block) and at most a handful of archives a day, so 30 is generous headroom
  // that still bounds a scripted-archive-spam loop.
  coach_distill: 30,
  // Video-recap frame commentary — one click sends every in-window entry frame
  // in a single multimodal call (vision-heavy, Opus for tiered users). 15/day
  // covers re-runs across a normal review session while bounding spend.
  recap_commentary: 15,
  profile_synth: 6,
  analyze_eod: 15,
  analyze_prep: 15,
  analyze_week: 8,
  predict_day_type: 15,
  extract_trade: 25,
  extract_context: 25,
  extract_themes: 15,
  trades_summary: 40,
  suggest_tags: 30,
  spell_check: 40,
}

export function aiLimitFor(action: string): number {
  return AI_LIMITS[action] ?? 3
}

/** YYYY-MM-DD for the given instant in America/Los_Angeles (matches the RPC). */
export function ptDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now)
}

export interface UsageResult {
  allowed: boolean
  used: number
  limit: number
  remaining: number
  message?: string
  migrationPending?: boolean
}

// Postgres/PostgREST codes meaning "the table or function isn't there yet".
const NOT_MIGRATED = new Set(['42883', '42P01', 'PGRST202', 'PGRST205', 'PGRST204'])

function limitReachedMessage(limit: number): string {
  return `Daily AI limit reached (${limit}/day). Resets at midnight Pacific.`
}

/**
 * Atomically consume one unit of the action's daily budget. Returns whether it
 * was allowed and the resulting counts. Call this ONCE per user action, before
 * the model call.
 */
export async function consumeAiUsage(
  db: AnyClient, action: string, limit: number = aiLimitFor(action),
): Promise<UsageResult> {
  const { data, error } = await db.rpc('consume_ai_usage', { p_action: action, p_limit: limit })
  if (error) {
    if (NOT_MIGRATED.has(error.code)) {
      return { allowed: true, used: 0, limit, remaining: limit, migrationPending: true }
    }
    // Unknown DB error → fail open (don't break a working feature over telemetry).
    return { allowed: true, used: 0, limit, remaining: limit, message: error.message }
  }
  const row = Array.isArray(data) ? data[0] : data
  const allowed = Boolean(row?.allowed)
  const used = Number(row?.used ?? 0)
  return {
    allowed,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    message: allowed ? undefined : limitReachedMessage(limit),
  }
}

/**
 * Read today's usage WITHOUT incrementing — for showing "N left today" on the
 * button. RLS scopes the row to the caller, so no user filter is needed.
 */
export async function peekAiUsage(
  db: AnyClient, action: string, limit: number = aiLimitFor(action),
): Promise<UsageResult> {
  const { data, error } = await db
    .from('ai_usage')
    .select('count')
    .eq('usage_date', ptDay())
    .eq('action', action)
    .maybeSingle()
  if (error) {
    if (NOT_MIGRATED.has(error.code)) {
      return { allowed: true, used: 0, limit, remaining: limit, migrationPending: true }
    }
    return { allowed: true, used: 0, limit, remaining: limit, message: error.message }
  }
  const used = Number(data?.count ?? 0)
  return {
    allowed: used < limit,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  }
}
