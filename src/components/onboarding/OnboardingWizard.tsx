'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import PathForkStep from './PathForkStep'
import NewTraderStep from './NewTraderStep'
import AccountStep from './AccountStep'
import PlaybookStep from './PlaybookStep'
import RulesStep from './RulesStep'
import ReviewStep from './ReviewStep'

// The veteran ("I trade a system") path — full capture, streamlined to 4 steps:
// step 1 required, 2–3 optional (opt-in grids / dismissable rails), and the
// "Your game" reflection demoted to an optional card inside Review. The
// new-trader path is a single screen (NewTraderStep) reached via the opening fork.
const STEPS = [
  { key: 'account', title: 'Account & markets' },
  { key: 'playbook', title: 'Your playbook' },
  { key: 'rules', title: 'Risk & rules' },
  { key: 'review', title: 'Review profile' },
] as const

type Phase = 'fork' | 'veteran' | 'new'

/**
 * First-time setup wizard shell. Opens with a one-tap fork (veteran vs new); the
 * veteran path runs the full multi-step capture, the new path is a single light
 * screen. Progress is tracked in onboarding_json, the user can skip at any point
 * (never blocks the app), and it marks itself completed at the end.
 */
export default function OnboardingWizard() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('fork')
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

  const pickPath = (p: 'veteran' | 'new') => {
    patch({ path: p })
    setStep(0)
    setPhase(p)
  }

  const next = () => {
    patch({ [`step_${STEPS[step].key}`]: true })
    if (step < total - 1) setStep(step + 1)
    else finish()
  }
  const back = () => {
    if (step === 0) setPhase('fork')
    else setStep(s => s - 1)
  }
  const finish = () => {
    patch({ status: 'completed', completed_at: new Date().toISOString() })
    router.push('/dashboard')
  }
  const skipAll = () => {
    patch({ status: 'skipped' })
    router.push('/dashboard')
  }

  if (phase === 'fork') {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <PathForkStep onPick={pickPath} onSkipAll={skipAll} />
        </div>
      </div>
    )
  }

  if (phase === 'new') {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <NewTraderStep onDone={finish} onSkipAll={skipAll} onBack={() => setPhase('fork')} />
        </div>
      </div>
    )
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
        {STEPS[step].key === 'review' && <ReviewStep onNext={next} onSkipAll={skipAll} />}
      </div>

      <button type="button" onClick={back} className="mt-4 text-sm text-gray-500 hover:text-gray-300">← Back</button>
    </div>
  )
}
