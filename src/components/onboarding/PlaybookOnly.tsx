'use client'

import { useRouter } from 'next/navigation'
import PlaybookStep from './PlaybookStep'

/**
 * Standalone wrapper for the playbook capture grid — the deep-link target of the
 * empty-tags nudge. Reuses PlaybookStep (the opt-in CaptureItem grid) verbatim;
 * both "Continue" and "Skip" just return to the dashboard rather than advancing
 * the multi-step wizard.
 */
export default function PlaybookOnly() {
  const router = useRouter()
  const done = () => router.push('/review')
  return <PlaybookStep onNext={done} onSkipAll={done} />
}
