/**
 * Trader profile / coaching preferences accessor.
 *
 * The trader writes standing context about their style (e.g. "my system is a
 * 2-ATR scalp", "I trade MNQ only") in /settings/coaching. This module reads
 * that text and provides it to every AI route via `getTraderProfile()`, which
 * each route prepends to its prompt so the AI respects the trader's actual
 * approach instead of generic critiques.
 *
 * Single-row design (single-user app): one row in `trader_profile` keyed by
 * id='default'. Migration: supabase/migrations/20260617_trader_profile.sql.
 *
 * Graceful degradation: if the table doesn't exist yet (migration not applied),
 * returns empty string instead of throwing. The app still works; the AI just
 * doesn't get the extra context until the migration runs.
 */

import { createClient } from '@/lib/supabase/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export interface TraderProfile {
  preferences_md: string
  updated_at: string | null
}

const EMPTY_PROFILE: TraderProfile = { preferences_md: '', updated_at: null }

/** Fetch the trader profile from Supabase. Returns the empty profile if the
 *  table doesn't exist (migration not applied) or the row is missing. */
export async function getTraderProfile(): Promise<TraderProfile> {
  try {
    const supabase: AnyClient = await createClient()
    const { data, error } = await supabase
      .from('trader_profile')
      .select('preferences_md, updated_at')
      .eq('id', 'default')
      .maybeSingle()
    if (error) {
      // Table-missing error: PostgREST returns PGRST205 ("not found in schema cache").
      // Swallow silently — caller treats no-profile as empty-profile.
      if (error.code === 'PGRST205' || error.code === '42P01') return EMPTY_PROFILE
      console.warn('[trader-profile] fetch error:', error.message, error.code)
      return EMPTY_PROFILE
    }
    if (!data) return EMPTY_PROFILE
    return {
      preferences_md: typeof data.preferences_md === 'string' ? data.preferences_md : '',
      updated_at: data.updated_at ?? null,
    }
  } catch (e) {
    console.warn('[trader-profile] fetch threw:', e instanceof Error ? e.message : 'unknown')
    return EMPTY_PROFILE
  }
}

/** Build a system-context block to prepend to AI prompts. Returns empty
 *  string when the profile is empty so prompts don't accidentally tell the
 *  AI "the trader provided NO context" (which would be a worse default than
 *  the AI just operating without it). Wrapping in distinct boundaries makes
 *  it visually unambiguous in the prompt where the trader's context ends and
 *  the actual analysis instructions begin. */
export function profileContextBlock(profile: TraderProfile): string {
  const text = profile.preferences_md.trim()
  if (!text) return ''
  return `═══════════════════════════════════════════════
TRADER PROFILE — standing context, RESPECT THIS
═══════════════════════════════════════════════
The trader has provided the following context about their style, system,
and preferences. Treat this as ground truth about HOW they trade. Do NOT
critique them for following these rules or violating generic "best
practices" that conflict with what they've explicitly described here.

${text}

═══════════════════════════════════════════════
END TRADER PROFILE
═══════════════════════════════════════════════

`
}
