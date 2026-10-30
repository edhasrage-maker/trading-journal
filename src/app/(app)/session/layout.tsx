/**
 * Session's content column — the same measure as its Week and Month pages
 * (ReviewShell), so the header and range switch don't jump between tabs.
 */
export default function SessionLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1080px]">{children}</div>
}
