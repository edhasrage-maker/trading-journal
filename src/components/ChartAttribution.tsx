/**
 * Attribution for the charting library.
 *
 * TapeScore's charts are drawn with TradingView's open-source Lightweight
 * Charts™ library (Apache 2.0). Its license asks every product that uses it to
 * show the library's attribution notice and a link to tradingview.com on a
 * page its users can see. The library's own on-chart logo satisfies that; our
 * charts hide the logo (`attributionLogo: false`) because it reads as if the
 * chart or its data were TradingView's, so this line carries the attribution
 * instead. Keep it on every surface that renders a chart: the app footer and
 * the shared-session page.
 */
export default function ChartAttribution({ className = '' }: { className?: string }) {
  return (
    <span className={className}>
      Charts by{' '}
      <a
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noopener noreferrer"
        title="TradingView Lightweight Charts™ — Copyright © TradingView, Inc."
        className="underline decoration-dotted underline-offset-2 hover:text-gray-300"
      >
        TradingView Lightweight Charts™
      </a>
    </span>
  )
}
