import { redirect } from 'next/navigation'
import { sessionPath } from '@/lib/session-route'

/** Deep links to the old per-day EOD recap keep working. */
export default async function EodDateRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { date } = await params
  redirect(sessionPath(date, await searchParams))
}
