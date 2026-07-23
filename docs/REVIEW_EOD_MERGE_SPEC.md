# Review / EOD Navigation Merge — Spec

**Status:** design spec (Pt 13, mockup phase — not built). Founder-directed 2026-07-22.
**Related:** `docs/tapescore-prep-mockup-r2.html` (Prep nav already updated), `docs/tapescore-dashboard-mockup-r4.html` (locked dashboard = the "Review · Month" view; still shows old nav).

## Decision

Stop treating **EOD** as a separate top-level destination. Merge EOD, Weekly, and the monthly
dashboard into **one** destination — **Review** — with time-scoped views. EOD becomes Review's
**Today** view.

> Merge the **navigation concept and data model** — NOT the interfaces into one giant page. Today/EOD,
> Week, and Month stay deliberately different views.

## Why

- The promised loop becomes literally visible: **Prep → Trade → Review**.
- **"Track this today"** (the Prep commitment) gets one obvious resolution home: **Review · Today**.
- The shared Intraday/EOD trade table (commits `744d84e`, `eb9213b`) gets one post-session home.
- Monthly findings and EOD debriefs become **different time scopes of the same activity**, not two products.
- Users no longer have to learn TapeScore's internal "EOD vs Review" distinction.

## Navigation

- **Top level:** `Prep · Trade · Review · Calendar · Patterns` (EOD removed).
- **Inside Review** (sub-nav / segmented control): `Today · Week · Month · All time` (all in v1).

## Route mapping (current → target)

The app has no `/review` route today; these three separate routes fold into it.

| Current | Role | Target |
|---|---|---|
| `/(app)/dashboard` | monthly overview = the locked "Review" mockup | `/review` (default view = **Month**) |
| `/(app)/eod` | per-day recap (`EodClient`) | `/review/today` |
| `/(app)/weekly` | week view | `/review/week` |
| — | monthly findings | `/review/month` |
| — | all-time findings (new, v1) | `/review/all-time` |

Add redirects: `/eod → /review/today`, `/weekly → /review/week`, `/dashboard → /review`.
Nav mapping for the rest: **Prep** = `/prep`, **Trade** = `/intraday`, **Calendar** = `/calendar`,
**Patterns** = `/analytics`.

## Open-state behavior (the loop's payoff)

- If today's session is **awaiting completion**, Review opens directly to **Today** with a clear
  **"Finish today's review"** affordance.
- After completion, Today becomes the **completed session review** — it does not bounce the trader
  elsewhere.
- When nothing is pending, Review defaults to **Month** (the findings view). *(Decided 2026-07-22:
  Month, not last-viewed.)*

## Data model

- One **"review" activity** viewed across time scopes. EOD debrief, weekly synthesis, and monthly
  findings are **views over the same trade/day data + coach outputs**, differing only by window.
- The **shared Intraday/EOD trade table** lives in **Review · Today**.
- **"Track this today"** persists a per-day commitment (from `prep_notes_json`); Review · Today reads
  it and **resolves it** (followed / not followed) at completion, feeding the finding engine. This is
  the loop — it must be operationalized, not just displayed. The bridge also supports **positive
  carryover** ("Protect this today"), so a resolved commitment can be a kept edge, not only an avoided
  leak.

## What stays distinct

Today/EOD, Week, and Month keep their own layouts, densities, and questions. Do **not** collapse them
into a single scrolling page. Merge nav + data model; preserve the three review views.

## Affected surfaces

- **Prep mockup** — nav updated ✓ (`Prep · Trade · Review · Calendar · Patterns`).
- **Locked dashboard mockup** — still shows the old six-item nav incl. EOD; needs the same one-line
  change when we next touch it (it *is* the Review · Month view).
- **App (build phase):** sidebar/nav link set, the new `/review` route + `Today/Week/Month` sub-views,
  redirects from `/eod` `/weekly` `/dashboard`, any deep links.

## Fallback (if the merge is NOT done)

If EOD stays a separate top-level destination, **Review must be renamed** to something unambiguous —
**Insights** or **Performance**. Keeping both `Review` and `EOD` as sibling top-level labels is the
weakest option.

## Decided (2026-07-22)

- **All time** ships in **v1** — Review sub-nav = `Today · Week · Month · All time`.
- Default Review scope when nothing is pending = **Month** (not last-viewed).
- Confirmed intent: a session **awaiting completion** opens Review directly to **Today**
  ("Finish today's review") — the entry point where the Prep "Track this today" commitment resolves.

## Open questions

1. Does **Trade** (`/intraday`) also surface its post-session state inside Review · Today, or stay
   purely live capture?
