import { createClient } from '@/lib/supabase/server'
import ConditionLookupSettings from '@/components/settings/ConditionLookupSettings'
import type { ConditionThreshold } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export default async function ConditionLookupPage() {
  const supabase: AnyClient = await createClient()

  const [
    { data: thresholds },
    { count: lookupCount },
    { data: meta },
  ] = await Promise.all([
    supabase.from('condition_thresholds').select('*').order('metric') as Promise<{ data: ConditionThreshold[] | null }>,
    supabase.from('condition_lookup').select('*', { count: 'exact', head: true }) as Promise<{ count: number | null }>,
    supabase
      .from('lookup_metadata')
      .select('value, updated_at')
      .eq('key', 'condition_lookup_refreshed_at')
      .maybeSingle() as Promise<{ data: { value: { at: string } | null; updated_at: string } | null }>,
  ])

  const refreshedAt = meta?.value?.at ?? null

  return (
    <div className="max-w-4xl mx-auto">
      <ConditionLookupSettings
        initialThresholds={thresholds ?? []}
        initialLookupCount={lookupCount ?? 0}
        initialRefreshedAt={refreshedAt}
      />
    </div>
  )
}
