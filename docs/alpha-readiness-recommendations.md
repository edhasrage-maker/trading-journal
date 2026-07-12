# TapeScore — Alpha-Readiness Recommendations

Compiled 2026-07-12 from: outside-trader persona critique (walkthrough video), live run-through
of tapescore.app (authenticated, desktop), and code/data verification against the deployed
`live-server-version` branch and the public Supabase project. Mockups: see the "TapeScore
Alpha-Readiness Redesign" artifact from the same session.

Founder decisions already made:
- **One TapeScore** (merge the score system) — approved in principle 2026-07-12.
- Chart light-theme inside dark app — founder-only preference, not a user-facing issue. Dropped.

---

## P0 — Fix before alpha invites (bugs, ops, first-run breakage)

1. **EOD "Overview" column renders one word per line.** At ~1290px the AI commentary column
   collapses to ~90px and every trade row becomes a ~300px ribbon of vertical text. The flagship
   AI feature is unreadable. Fix: take the overview out of the column grid — render it as a
   full-width expandable sub-row (2-line clamp + "more"), or give the column a real min-width
   with the table in `overflow-x: auto`. (`src/components/eod/TradeList.tsx`)
2. **support@tapescore.app bounces (no MX)** and is load-bearing: footer (`AppMain.tsx:28`),
   Terms, and Privacy — which legally promises data-deletion requests via that address.
   USER ACTION: Cloudflare Email Routing / Workspace forwarding. ~30 min.
3. **Public prod DB has no backups** (Supabase Free). USER ACTION: upgrade to Pro before
   external users have journals worth losing.
4. **Revoke the old `sbp_` access token.** USER ACTION (standing checklist item).
5. **CSV importer never validated against real third-party exports** (NinjaTrader "Trade
   Performance", Tradovate "Performance", Tradezella). This is every alpha tester's first
   action. Collect one real export per tester BEFORE invites and run them through
   (`src/lib/csv-trade-import.ts`).
6. **Analytics ships the user's entire trade history to the browser** — 6,217 trades / ~6.3MB
   serialized props for the founder's account; grows unbounded. Add server-side date-window
   filtering (client already has the range selector) or cap + lazy-load. Note: the two
   ~10-minute renderer hangs observed 2026-07-12 on /analytics in Detailed Tape did NOT
   reproduce under instrumentation (0 long tasks across toggle cycles; all aggregations
   measured at ms-scale on the exact cloud data; data verified sane). Treat as unconfirmed /
   possibly environmental — but shrink the payload anyway and consider a `longtask` beacon
   so a real user hitting it would be visible.
7. **Raw white Next.js 404s inside the app** — bare `/prep`, `/weekly` (any un-dated route)
   dead-end with no app shell. Add a branded not-found page + redirect bare routes to
   today/current week.
8. **Daily Prep shows red "Unsaved" on first load** before the user touches anything
   (auto-filled market context marks the form dirty). Auto-fill must not set the dirty flag.
9. **EOD chart opens panned to the wrong session** — e.g. 2026-07-02 opens on the overnight
   tail (20:15–23:45) while all trades were 08:12–11:11 PT. Default the visible range to the
   trade cluster.
10. **Mixed-instrument days have no instrument indicator** — an ES trade (entry 7505.75) sits
    unexplained among NQ 29,7xx entries. Add an instrument badge per trade row (show only when
    the day is mixed, or always in Detailed).
11. **Demo account blank AI panels / empty charts** (deferred wave-2 polish). The demo is the
    top of funnel for skeptics; promote to launch-blocking if the alpha funnel is demo-first.
12. Quick confirmations: nightly condition-lookup cron actually firing; site tour on a real
    device; chart-on-touch on a real phone.

## P1 — Legibility & trust (the first-90-seconds problems)

13. **One TapeScore.** Merge Execution / Compliance / Process into a single headline score per
    day (the product is named after it), with expandable components. Kill the word
    "Compliance"; components read as plain language ("Rules kept 4/5", "Execution quality",
    "Prep"). Even the founder blurs the current three on tape. Touches Ruleset spec +
    dashboard/EOD surfaces — needs a spec amendment first.
14. **Verdict-first conditions.** Every conditions chip leads with a plain-language verdict,
    raw metric second: "Volatility: very high — 1-min ATR 6.9pts (~2.7× normal)". Never a bare
    "ATR is 69" (unlabeled 1-minute ATR reads as nonsense to outsiders).
15. **n= badges everywhere; suppress thin samples.** "WR 37% · PF 1.41" without n is false
    precision. Grey out any aggregate under a threshold with "n=6 — too few to judge".
    Suppression *builds* trust.
16. **Trader-profile-driven UI.** Hide order-flow tag tables/columns unless the profile opts
    in — the rule already exists for the AI lens; mirror it in the UI. Same for IB-centric
    surfaces.
17. **Highlights as the default for new accounts**; Detailed Tape is the graduation. Persist
    the mode server-side per user (currently localStorage-only → desynced across tabs/devices).
18. **Kill internal-stats copy**: "Tertile view selected — larger sample (410 trades vs 1)" →
    "Based on 410 similar days". No user-facing "tertile"/"median view".
19. **Fix "↓ -$0 vs your avg"** negative-zero formatting on the prep EV card.
20. **"Trade Journal • NQ" → TapeScore** branding on the Discord share card (old name leaks on
    the one surface designed to be posted publicly).
21. **"GBX" → "Overnight"** in all user-facing chips/copy.

## P2 — Make the loop and the differentiator land

22. **Post-import retroactive recap.** After first import, auto-open an EOD-style recap of the
    tester's best/worst historical day — post-exit verdicts, heat/capture, behavioral flags on
    THEIR trades within 5 minutes of signup. This is "pays off on day one" made literal, and it
    teaches the Prep→Trade→Review loop backwards.
23. **Promote post-exit verdicts + entry efficiency to the EOD hero.** The plain-language panel
    ("You capture 1.1×ATR while taking only 0.4×ATR of heat — your entry timing is sharp") is
    the best thing in the product. Same for behavioral flags. Lead with them.
24. **Landing page: lead with "we grade your decisions, not your P&L"** + the screenshot-paste
    magic moment. Demote "AI insight" (commoditized — every competitor claims it).
25. **Dashboard hero = TapeScore trend**, P&L one level down (aligns with the report-card
    direction already built for Highlights).

## Cut / bury list

- Manual trade entry → behind an "Add manually" link (founder's own words: nobody will use it).
- Hourly journal notes → optional collapsed drawer.
- Weekly Recap → demote from top-level nav until coach themes have data (fold into Dashboard).
- Recording recap → keep the BETA badge; keep out of headline marketing until judged on a real
  session.
- Raw conditions grid (RVOL/ADR%/IB%/ATR) → collapse behind the verdict chips.
- Mistakes/Emotions impact tables → already hidden pending redesign; keep hidden.

## Strategic (from the market-viability discussion, 2026-07-12)

- Distribution beats features in this market (TradeZella won on audience). Spend part of the
  year on: founder-content (the share card is the seed), one prop-firm partnership, and the
  alpha Discord.
- The real success metric for the next 90 days: **20 external traders journaling 3+ days/week
  unprompted** — not feature count.
- Durable moats in order: futures-native data model, per-user coach memory, (later)
  cross-trader benchmarks. "We have AI" is not one.
