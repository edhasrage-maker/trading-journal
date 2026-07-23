// The EOD trade table was extracted into the shared SessionTradeTable so the
// Intraday (capture) and EOD (review) surfaces render from one implementation
// (Session-merge Pt 13, step 1). EOD keeps importing `./TradeList`; the default
// `config` is 'review', so this render is byte-identical to the pre-merge table.
export { default } from '@/components/session/SessionTradeTable'
