import CoachingPreferencesClient from '@/components/settings/CoachingPreferencesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function CoachingSettingsPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-2">Coaching Preferences</h1>
      <p className="text-gray-400 text-sm mb-8">
        Standing context about your trading style. This gets injected into every AI
        prompt (EOD analysis, prep analysis, day-type prediction, video commentary,
        etc.) so the coach respects your actual approach.
      </p>
      <CoachingPreferencesClient />
    </div>
  )
}
