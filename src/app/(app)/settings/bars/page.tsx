import { createClient } from '@/lib/supabase/server'
import BarImportClient from '@/components/settings/BarImportClient'
import type { BarImport } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export default async function BarsSettingsPage() {
  const supabase: AnyClient = await createClient()
  const { data: importsRaw } = await supabase
    .from('bar_imports')
    .select('*')
    .order('imported_at', { ascending: false })
    .limit(50) as { data: BarImport[] | null }

  return (
    <div className="max-w-4xl mx-auto">
      <BarImportClient initialImports={importsRaw ?? []} />
    </div>
  )
}
