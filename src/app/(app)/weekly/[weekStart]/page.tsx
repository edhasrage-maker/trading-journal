import { redirect } from 'next/navigation'

/** Deep links to the old weekly recap keep working. */
export default async function WeeklyDateRedirect({ params }: { params: Promise<{ weekStart: string }> }) {
  const { weekStart } = await params
  redirect(`/review/week/${weekStart}`)
}
