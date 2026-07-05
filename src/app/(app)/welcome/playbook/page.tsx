import PlaybookOnly from '@/components/onboarding/PlaybookOnly'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** Deep-link for the empty-tags nudge — just the playbook capture, not the wizard. */
export default function PlaybookSetupPage() {
  return (
    <div className="min-h-[70vh]">
      <div className="max-w-2xl mx-auto px-6 pt-6">
        <h1 className="text-2xl font-bold text-white">Add your setups</h1>
        <p className="text-gray-400 text-sm mt-1">
          Tag the setups, confluences, and entries you actually trade — it teaches your coach what to grade.
          Skip anything you don&apos;t use.
        </p>
      </div>
      <div className="max-w-2xl mx-auto px-6 py-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <PlaybookOnly />
        </div>
      </div>
    </div>
  )
}
