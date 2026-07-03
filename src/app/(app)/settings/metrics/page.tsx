import AtrSettingsClient from '@/components/settings/AtrSettingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function MetricsSettingsPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-2">Metrics</h1>
      <p className="text-gray-400 text-sm mb-8">
        Choose how ATR is measured across your trade metrics — timeframe, smoothing
        method, and period. This drives the ATR@ column and the ATR-based R used when
        a trade has no planned stop.
      </p>
      <AtrSettingsClient />
    </div>
  )
}
