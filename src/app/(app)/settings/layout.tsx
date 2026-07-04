/**
 * Constrains every Settings page to a readable column. The app pages went
 * full-width in the desktop UX pass, which left settings forms stretched and
 * awkwardly wide on large screens. A `max-w-4xl` is a no-op below 896px, so
 * mobile keeps its full-width layout automatically (no responsive prefix
 * needed). Left-aligned (no mx-auto) to sit flush under the sidebar, matching
 * how each page's heading already aligns.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <div className="max-w-4xl">{children}</div>
}
