import CommissionSettingsClient from '@/components/settings/CommissionSettingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function CommissionSettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-2">Commissions</h1>
      <p className="text-gray-400 text-sm mb-8">
        Set your per-contract commission so imported P&amp;L reflects real net results.
        This is applied automatically at import to logs that don&apos;t include their own
        commissions (like Sierra Chart, which exports gross P&amp;L).
      </p>
      <CommissionSettingsClient />
    </div>
  )
}
