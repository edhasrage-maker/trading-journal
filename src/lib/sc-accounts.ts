/**
 * Client-side helpers for splitting a Sierra Chart trade-activity log by account.
 *
 * A copy-trading / prop-firm setup mirrors every master fill into dozens (here:
 * 157) of funded + eval accounts, so a single YTD export balloons to megabytes
 * and reconstructs to the same trades multiplied per account. Two problems fall
 * out of that: the upload exceeds the serverless request-body limit (~4.5 MB on
 * Vercel), and importing the whole thing floods the journal with N copies of
 * every trade.
 *
 * Filtering to the chosen account(s) in the browser BEFORE upload fixes both —
 * the payload shrinks to one account's fills, and the journal gets one clean
 * copy. These are string ops on the raw text; the server parser is unchanged.
 */

// Mirrors sc-importer.ts's SIM_ACCOUNT_RE (kept inline so this stays a tiny
// client bundle instead of pulling the whole parser in). Anything not sim/None
// is treated as a live account.
const SIM_ACCOUNT_RE = /^(None|Sim\d*)$/i
function isLive(account: string): boolean {
  const a = account.trim()
  return !!a && !SIM_ACCOUNT_RE.test(a)
}

/** A Sierra log is tab-separated and its header carries ActivityType + FillPrice. */
export function isSierraLogText(text: string): boolean {
  const nl = text.indexOf('\n')
  const first = (nl === -1 ? text : text.slice(0, nl)).toLowerCase()
  return first.includes('\t') && first.includes('activitytype') && first.includes('fillprice')
}

export interface SierraAccount {
  account: string
  fills: number
}

/** Distinct LIVE trade accounts in a Sierra log with their fill counts,
 *  most-active first. Empty when the file isn't a recognizable Sierra log. */
export function sierraAccountsInLog(text: string): SierraAccount[] {
  const lines = text.split(/\r?\n/)
  if (lines.length < 2) return []
  const header = lines[0].split('\t').map(h => h.trim().toLowerCase())
  const acctCol = header.indexOf('tradeaccount')
  const typeCol = header.indexOf('activitytype')
  if (acctCol < 0) return []

  const counts = new Map<string, number>()
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    const c = lines[i].split('\t')
    if (typeCol >= 0 && c[typeCol] !== 'Fills') continue
    const a = (c[acctCol] ?? '').trim()
    if (!isLive(a)) continue
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([account, fills]) => ({ account, fills }))
    .sort((x, y) => y.fills - x.fills || x.account.localeCompare(y.account))
}

/** Header + only the rows whose TradeAccount is in `accounts`. Preserves the
 *  file's original line ending so the server parser reads it identically. */
export function filterSierraLogByAccounts(text: string, accounts: Set<string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.length < 2) return text
  const header = lines[0].split('\t').map(h => h.trim().toLowerCase())
  const acctCol = header.indexOf('tradeaccount')
  if (acctCol < 0) return text

  const out: string[] = [lines[0]]
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const a = (line.split('\t')[acctCol] ?? '').trim()
    if (accounts.has(a)) out.push(line)
  }
  return out.join(eol) + eol
}
