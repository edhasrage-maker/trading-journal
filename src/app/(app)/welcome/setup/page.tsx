import OnboardingWizard from '@/components/onboarding/OnboardingWizard'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function SetupPage() {
  return (
    <div className="min-h-[70vh]">
      <div className="max-w-2xl mx-auto px-6 pt-6">
        <h1 className="text-2xl font-bold text-white">Set up your coach</h1>
        <p className="text-gray-400 text-sm mt-1">
          A few minutes to tell your AI coach how you trade — your markets, playbook, rules, and what you want to work on.
          Skip anything; you can finish later.
        </p>
      </div>
      <OnboardingWizard />
    </div>
  )
}
