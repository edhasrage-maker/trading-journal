import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdminUser } from '@/lib/ai-model'
import { isServiceConfigured } from '@/lib/supabase/service'
import ModelTiersClient from '@/components/settings/ModelTiersClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ModelTiersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Admin-only, cloud-only (needs the service role to list users + write tiers).
  if (!isAdminUser(user) || !isServiceConfigured()) redirect('/settings/coaching')

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-2">Model Tiers</h1>
      <p className="text-gray-400 text-sm mb-8">
        Set which users run on the premium model. Everyone defaults to the standard model; grant a user the
        upgraded tier and their AI features (coach, recap, analysis) resolve to it server-side. Admins are always
        on the upgraded tier automatically.
      </p>
      <ModelTiersClient />
    </div>
  )
}
