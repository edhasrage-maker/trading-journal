import { createClient } from '@/lib/supabase/server'
import ScLogsClient, { type ScLogFile } from '@/components/settings/ScLogsClient'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export default async function ScLogsPage() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase.storage
    .from('sc-logs')
    .list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } }) as {
      data: ScLogFile[] | null
      error: { message: string } | null
    }

  return (
    <div className="max-w-4xl mx-auto">
      {error ? (
        <div className="bg-red-950/40 border border-red-900 text-red-300 rounded-xl p-5 text-sm">
          Could not list sc-logs bucket: {error.message}
          <p className="text-xs text-red-400/70 mt-2">
            If the bucket doesn&apos;t exist yet, create it in Supabase Dashboard → Storage.
          </p>
        </div>
      ) : (
        <ScLogsClient initialFiles={data ?? []} />
      )}
    </div>
  )
}
