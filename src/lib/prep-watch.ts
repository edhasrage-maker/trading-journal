import type { AiAnalysis } from '@/lib/supabase/types'

/**
 * Highlights Prep's one thing to watch and one thing to keep.
 *
 * Two sources write a Watch: the small Highlights call (/api/prep/watch →
 * `watch` + `watch_at`) and the full morning read (its first flag, stamped
 * `analyzed_at`). Whichever ran last wins, so pressing either button always
 * changes what the trader sees. Keep is the full read's first strength.
 */
export function watchAndKeep(analysis: AiAnalysis | null): { watch: string | null; keep: string | null } {
  const fullWatch = analysis?.flags?.find(Boolean) ?? null
  const quick = analysis?.watch || null
  const quickNewer = !!quick && (
    !fullWatch || !analysis?.analyzed_at || (analysis.watch_at ?? '') >= analysis.analyzed_at
  )
  return {
    watch: quickNewer ? quick : fullWatch,
    keep: analysis?.strengths?.find(Boolean) ?? null,
  }
}
