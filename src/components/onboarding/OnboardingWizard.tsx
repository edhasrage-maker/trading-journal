'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AccountStep from './AccountStep'
import PlaybookStep from './PlaybookStep'
import RulesStep from './RulesStep'
import YourGameStep from './YourGameStep'
import ReviewStep from './ReviewStep'

// Each step renders with the nav callbacks below. Review (last) drafts the AI
// Player Profile and saves it on finish.
const STEPS = [
  { key: 'account', title: 'Account & markets' },
  { key: 'playbook', title: 'Your playbook' },
  { key: 'rules', title: 'Risk & rules' },
  { key: 'yourgame', title: 'Your game' },
  { key: 'review', title: 'Review profile' },
] as const

/**
 * First-time setup wizard shell. Tracks progress in onboarding_json, lets the
 * user skip at any point (never blocks the app), and marks itself completed at
 * the end. Reachable at /welcome/setup; not auto-triggered until Phase 5.
 */
export default function OnboardingWizard() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const total = STEPS.length

  // Mark in-progress on first entry (so the "finish your profile" banner knows).
  useEffect(() => {
    fetch('/api/onboarding')
      .then(r => r.json())
      .then(d => {
        const st = d.onboarding?.status
        if (st !== 'completed' && st !== 'in_progress') {
          fetch('/api/onboarding', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onboarding: { status: 'in_progress' } }),
          }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  const patch = (onboarding: Record<string, unknown>) =>
    fetch('/api/onboarding', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding }),
    }).catch(() => {})

  const next = () => {
    patch({ [`step_${STEPS[step].key}`]: true })
    if (step < total - 1) setStep(step + 1)
    else finish()
  }
  const back = () => setStep(s => Math.max(0, s - 1))
  const finish = () => {
    patch({ status: 'completed', completed_at: new Date().toISOString() })
    router.push('/dashboard')
  }
  const skipAll = () => {
    patch({ status: 'skipped' })
    router.push('/dashboard')
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <div className="mb-8">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
          <span>Step {step + 1} of {total}</span>
          <span className="text-gray-400">{STEPS[step].title}</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${((step + 1) / total) * 100}%` }} />
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        {STEPS[step].key === 'account' && <AccountStep onNext={next} onSkipAll={skipAll} />}
        {STEPS[step].key === 'playbook' && <PlaybookStep onNext={next} onSkipAll={skipAll} />}
        {STEPS[step].key === 'rules' && <RulesStep onNext={next} onSkipAll={skipAll} />}
        {STEPS[step].key === 'yourgame' && <YourGameStep onNext={next} onSkipAll={skipAll} />}
        {STEPS[step].key === 'review' && <ReviewStep onNext={next} onSkipAll={skipAll} />}
      </div>

      {step > 0 && (
        <button type="button" onClick={back} className="mt-4 text-sm text-gray-500 hover:text-gray-300">← Back</button>
      )}
    </div>
  )
}
