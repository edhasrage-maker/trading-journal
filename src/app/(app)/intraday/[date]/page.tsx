import { redirect } from 'next/navigation'
import { sessionPath } from '@/lib/session-route'

/** The Log merged into the Session page; old links (and ?trade=) still land. */
export default async function IntradayDateRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { date } = await params
  redirect(sessionPath(date, await searchParams))
}
