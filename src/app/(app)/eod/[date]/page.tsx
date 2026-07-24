import { redirect } from 'next/navigation'

/** Deep links to the old per-day EOD recap keep working. */
export default async function EodDateRedirect({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  redirect(`/review/today/${date}`)
}
