/**
 * Where the Session page lives, and where the routes it replaced now send you.
 *
 * Log (/intraday/<date>) and Recap (/review/today/<date>) merged into one page,
 * /session/<date>. The old URLs stay alive as redirects — bookmarks, shared
 * links and the ?trade= deep links all still land — so they carry the query
 * string across untouched.
 */

type Query = Record<string, string | string[] | undefined>

/** /session/<date>, with the incoming query string (e.g. ?trade=<id>) kept. */
export function sessionPath(date: string, query?: Query): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) value.forEach(v => qs.append(key, v))
    else if (value != null) qs.append(key, value)
  }
  const s = qs.toString()
  return `/session/${date}${s ? `?${s}` : ''}`
}
