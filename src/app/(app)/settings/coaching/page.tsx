import CoachingPreferencesClient from '@/components/settings/CoachingPreferencesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function CoachingSettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-2">Player Profile</h1>
      <p className="text-gray-400 text-sm mb-8">
        The context your AI coach uses to read your game. It&apos;s injected into every AI
        prompt (EOD analysis, prep analysis, day-type prediction, video commentary,
        etc.) so the coach respects your actual approach.
      </p>
      <CoachingPreferencesClient />
    </div>
  )
}
