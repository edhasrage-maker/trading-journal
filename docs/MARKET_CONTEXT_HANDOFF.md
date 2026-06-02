# Market Context Backfill — Cross-PC Handoff Brief

You're a Claude Code instance helping populate the **market_context** and
**daily_prep** tables for a personal trading journal. The trader runs the
journal on two Windows machines that share the same Supabase Postgres
backend. One PC has the SCID files for the relevant contract period; the
other doesn't. This brief is everything you need to compute and upload the
data — no other project context required.

The journal trades **NQ/MNQ futures** (Nasdaq-100 micro and full). All
"prices" in this doc are NQ index points (e.g., a typical NQ close is
22,000.00). NQ and MNQ share identical prices — they're the same index,
just different point values.

---

## 1. What you're filling in

Per **trading date** (YYYY-MM-DD in America/Los_Angeles), produce these
fields and upsert them into Supabase.

### Table: `market_context` (FK → `trading_days.id`)

| Field | Type | Unit | What it means |
|---|---|---|---|
| `pdh` | numeric | NQ points | Prior-day RTH **high** |
| `pdl` | numeric | NQ points | Prior-day RTH **low** |
| `onh` | numeric | NQ points | Overnight (Globex) high — prior-day 15:00 PT through today's 06:30 PT |
| `onl` | numeric | NQ points | Overnight low (same window) |
| `ibh` | numeric | NQ points | Initial Balance high — today's 06:30–07:30 PT |
| `ibl` | numeric | NQ points | Initial Balance low |
| `ib_size` | numeric | NQ points | `ibh − ibl` |
| `rvol` | numeric | **percentage** | Today's RTH volume ÷ avg RTH volume over previous **10 trading days**, **× 100** (100 = average, 150 = 50% above, 70 = 30% below) |
| `adr` | numeric | NQ points | Avg of (RTH high − RTH low) over previous 10 trading days |
| `ib_vs_10d_avg` | numeric | ratio | `ib_size ÷ avg(ib_size) over previous 10 trading days` |
| `atr_1m` | numeric | NQ points | Wilder ATR(10) over 1-minute bars, value at the LAST RTH bar of the target day |
| `symbol` | text | — | `'NQ'` (constant for this trader) |

### Table: `daily_prep` (keyed by `trade_date`, NOT FK)

| Field | Type | Unit | What it means |
|---|---|---|---|
| `trade_date` | date | — | YYYY-MM-DD |
| `rvol` | numeric | ratio | Same as market_context.rvol (sometimes captured at 07:30 PT IB end vs EOD; either acceptable) |
| `dr_adr` | numeric | ratio | Today's day range so far ÷ ADR. At 07:30 PT IB end this is (IBH − IBL) / ADR |
| `ib` | numeric | ratio | Same as `ib_vs_10d_avg` |
| `atr_730` | numeric | NQ points | ATR-1m value at 07:30 PT (one hour into RTH) |
| `atr_entry` | numeric | NQ points | ATR-1m value at the trader's first trade entry. Skip for backfill — needs per-trade times. |
| `notes` | text | — | Optional free-text |

For the backfill, **focus on market_context.** `daily_prep` is per-day
prep notes the trader fills out manually; you only need to mirror the
ratios already in market_context.

---

## 2. Session windows (Pacific Time, wall-clock, exchange-anchored)

These are constants. Use them to slice 1-minute bars by their PT
timestamp:

| Window | PT range | Used for |
|---|---|---|
| **ETH (Globex)** | prior day 15:00 → today 14:00 | overnight + extended session |
| **RTH** | today 06:30 → 13:00 | "regular trading hours" — volume, range, ATR |
| **IB (Initial Balance)** | today 06:30 → 07:30 | first hour of RTH |
| **Weekly anchor** | most recent Sunday 15:00 PT | not needed for this backfill |

DST is handled by Intl with `America/Los_Angeles`. Bars stored in UTC,
converted to PT for windowing.

---

## 3. Where to get the bars (SCID files)

Sierra Chart writes one `.scid` file per contract month at
**`D:\SierraCharts\Data\`** (override with `SIERRA_DATA_DIR` env).

NQ front-month roll calendar (the dates this brief covers, Jun 2025 –
Apr 2026):

| SCID file (try both naming forms) | Active for these PT dates |
|---|---|
| `NQM5.CME.scid` / `NQM25-CME.scid` | 2025-03-13 → 2025-06-11 |
| `NQU5.CME.scid` / `NQU25-CME.scid` | 2025-06-12 → 2025-09-10 |
| `NQZ5.CME.scid` / `NQZ25-CME.scid` (or lowercase `NQz5.CME.scid`) | 2025-09-11 → 2025-12-10 |
| `NQH6.CME.scid` / `NQH26-CME.scid` | 2025-12-11 → 2026-03-11 |
| `NQM6.CME.scid` / `NQM26-CME.scid` | 2026-03-12 → 2026-06-10 |

Each SCID's data window may extend earlier than its roll period (Sierra
keeps recording prior to becoming front-month). Test by reading bars
and checking that the target date has volume.

**Use NQ SCIDs even though the trader's symbol is MNQ** — they share
identical prices, and NQ has more volume history.

### SCID format

40-byte header + 40-byte records. Each record:

```
int64  ScDateTimeMS         // microseconds since 1899-12-30 00:00:00 UTC
float  Open                  // raw price * priceDivisor (100 for NQ)
float  High
float  Low
float  Last  (= Close)
uint32 NumTrades
uint32 TotalVolume
uint32 BidVolume
uint32 AskVolume
```

To convert raw → points: `price = raw / 100`.

To convert ScDateTime → JS Date: `epochMs = (sc_us / 1000) + Date.UTC(1899, 11, 30)`.

The journal already has a reader at `src/lib/scid-reader.ts` that aggregates
ticks into 1-minute bars. If you're working in the same codebase, use it.
Reference signature:

```ts
readScidBars(path: string, startMs: number, endMs: number, { priceDivisor: 100 })
  // returns { bars: Array<{ ts: ISO_UTC, open, high, low, close, volume }> }
```

---

## 4. Computation formulas

Given an array of 1-minute bars `RawBar[]` covering the target date plus
at least **15 calendar days of lookback** (10 trading days × ~1.5
weekend padding):

### `rvol` (stored as percentage)
```
todays_rth_volume    = Σ bar.volume where bar in RTH on target date
prior_n_rth_volumes  = [Σ volume per RTH window] for the last 10 trading days BEFORE target
rvol                 = (todays_rth_volume / mean(prior_n_rth_volumes)) * 100
                       // 100 = average, 150 = 50% above, 70 = 30% below
```

### `adr`
```
adr = mean( (rth_high - rth_low) for each of the last 10 trading days before target )
```

### `ib_size`
```
ib_size = max(bar.high where bar in IB on target) - min(bar.low where bar in IB on target)
```

### `ib_vs_10d_avg`
```
prior_ib_sizes = [IB size] for each of the last 10 trading days before target (where IB had data)
ib_vs_10d_avg  = today's ib_size / mean(prior_ib_sizes)
```

### `atr_1m`
Wilder's ATR over the entire bar series:
```
TR[0]   = bar[0].high - bar[0].low
TR[i]   = max(bar[i].high - bar[i].low, |bar[i].high - bar[i-1].close|, |bar[i].low - bar[i-1].close|)
ATR[9]  = mean(TR[0..9])
ATR[i]  = (ATR[i-1] * 9 + TR[i]) / 10                  for i ≥ 10
```
Report the value at the **last 1-minute bar of RTH on the target date**.

### Prior-day / overnight / IB price levels
```
pdh = max(bar.high) over previous trading day's RTH window
pdl = min(bar.low)  over previous trading day's RTH window
onh = max(bar.high) over [prior-day 15:00 PT, today 06:30 PT)
onl = min(bar.low)  over [prior-day 15:00 PT, today 06:30 PT)
ibh = max(bar.high) over [today 06:30 PT, today 07:30 PT)
ibl = min(bar.low)  over [today 06:30 PT, today 07:30 PT)
```

The journal already has a reference implementation at
`src/lib/session-levels.ts` (computeSessionLevels) that returns
`pdh, pdl, ibh, ibl, onh, onl` from the same bar inputs. If you're in
the same codebase, call it. If not, the formulas above are exact.

`src/lib/compute-market-context.ts` covers RVOL/ADR/IB-vs-10d/ATR-1m.

---

## 5. How to upload to Supabase

Two paths — pick based on your situation.

### Path A: Hit the existing backfill endpoint (preferred)

If the journal repo is checked out on your machine and the dev server
is running, just POST:

```bash
curl -s -X POST http://localhost:3000/api/historical/backfill-market-context \
  -H 'Content-Type: application/json' \
  -d '{"scidFile":"NQU25-CME.scid","dryRun":true}'
```

`dryRun: true` returns the computed metrics without writing.
`dryRun: false` writes (idempotent: skips dates that already have a row
unless `force: true`).

The endpoint auto-discovers historical trade dates from `historical_trades`,
finds dates that fall inside the SCID's window, computes each, and upserts
into `market_context`.

### Path B: Direct service-role write (no journal repo needed)

If you only have access to Supabase and the SCID files (no journal repo
on disk), write directly. The trader's pattern from `CLAUDE.md`:

```bash
node -e "
  const fs=require('fs');
  for(const l of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){
    const m=l.match(/^([A-Z_]+)=(.*)\$/);
    if(m) process.env[m[1]] = m[2].replace(/^[\"']|[\"']\$/g,'');
  }
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  (async () => {
    // For each target date:
    const rows = [/* fill in computed objects */];
    for (const r of rows) {
      // 1. Find or create trading_day
      let { data: day } = await sb.from('trading_days').select('id').eq('date', r.date).single();
      if (!day) {
        const created = await sb.from('trading_days').insert({ date: r.date }).select('id').single();
        day = created.data;
      }
      // 2. Upsert market_context
      await sb.from('market_context').upsert({
        trading_day_id: day.id,
        symbol: 'NQ',
        pdh: r.pdh, pdl: r.pdl, onh: r.onh, onl: r.onl, ibh: r.ibh, ibl: r.ibl,
        rvol: r.rvol, adr: r.adr, ib_size: r.ib_size, ib_vs_10d_avg: r.ib_vs_10d_avg, atr_1m: r.atr_1m,
      }, { onConflict: 'trading_day_id' });
    }
    console.log('done');
  })();
"
```

Service-role bypasses RLS so the upsert works without auth. `.env.local`
in the repo root has the keys.

### Path C: Hand back a filled CSV

If you'd rather not write to Supabase at all, fill in
`docs/market-context-template.csv` and hand it back. The trader can import
via the journal's UI at **Settings → Tradezella → Import market context
CSV** (endpoint: `POST /api/historical/import-market-context-csv`).
That endpoint validates and upserts the same way Path B does.

CSV columns: `trade_date, pdh, pdl, onh, onl, ibh, ibl, ib_size, rvol, adr, ib_vs_10d_avg, atr_1m`.
Numeric fields may be blank — they'll be stored as NULL.

---

## 6. Sanity ranges (NQ-typical values)

If you're producing numbers wildly outside these ranges, check
`priceDivisor` (should be 100 for NQ) and your PT timezone conversion:

| Field | Typical range | Median |
|---|---|---|
| pdh, pdl | 18,000 – 24,000 | varies |
| onh − onl | 80 – 300 | ~170 |
| ib_size | 80 – 350 | ~185 |
| rvol | 50 – 250 (percent) | 100 |
| adr | 250 – 450 | ~325 |
| ib_vs_10d_avg | 0.4 – 2.0 | 1.0 |
| atr_1m | 5 – 25 | ~13 |

---

## 7. Idempotency + safety

- `market_context.trading_day_id` is uniquely keyed (in practice one row
  per day; upsert on it). Always check before insert.
- `trading_days.date` is uniquely keyed. Always check before insert —
  the trader may already have a `trading_day` for that date from the
  prep page.
- Dates outside the SCID's data window cannot be computed from that SCID
  — try a different contract.
- The first 1–2 days of each contract's window will have null RVOL/ADR
  (no prior trading days to average against). That's fine — re-run with
  the adjacent contract once it's backfilled and use `force: true` to
  refill those edges.

---

## 8. What to deliver back to the trader

If using Path A or B (direct write): the upserted rows are in Supabase
— the trader's analytics page picks them up on next refresh.

If using Path C (CSV): hand back the filled
`docs/market-context-template.csv` and mention which contracts you
covered + any dates skipped (with reasons).

Either way, summarize at the end:

- How many dates you processed
- Date range covered
- Which SCID(s) you read from
- Any dates skipped + why
- Any sanity-check warnings (values outside the typical ranges in §6)
