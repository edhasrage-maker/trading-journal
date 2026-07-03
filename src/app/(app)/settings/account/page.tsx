import ProfileSettingsClient from '@/components/settings/ProfileSettingsClient'
import CommissionSettingsClient from '@/components/settings/CommissionSettingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AccountSettingsPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-2">Account Settings</h1>
      <p className="text-gray-400 text-sm mb-8">
        How your account and numbers are set up — trading defaults, commissions, and ATR display.
      </p>

      <div className="space-y-8">
        {/* Profile — trading defaults */}
        <ProfileSettingsClient />

        {/* Commissions */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Commissions</h2>
          <CommissionSettingsClient />
        </div>

        {/* ATR — slot for the ATR-display settings (built separately). */}
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            ATR
            <span className="text-[10px] uppercase tracking-wider text-amber-400/80 border border-amber-800/50 rounded px-1.5 py-0.5">Setup in progress</span>
          </h2>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-sm text-gray-500">
            Controls for how ATR-based metrics (MFE / MAE shown in ×ATR) display and which ATR period drives them. Being set up — it&apos;ll appear here shortly.
          </div>
        </div>
      </div>
    </div>
  )
}
