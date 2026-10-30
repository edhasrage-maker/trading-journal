import { redirect } from 'next/navigation'
import { sessionPath } from '@/lib/session-route'

/** The Recap merged into the Session page; old links (and ?trade=) still land. */
export default async function ReviewTodayRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { date } = await params
  redirect(sessionPath(date, await searchParams))
}
