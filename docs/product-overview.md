# TapeScore — product overview

> Read-this-first orientation for anyone (human or model) working on TapeScore.
> This is the PRODUCT vision + domain vocabulary. For architecture/tech context
> see `CLAUDE.md`; for coach-AI behavior see `docs/coach-brief.md`.

## One line
**"Game film for traders."** TapeScore is an AI trading coach + journal that
reviews a trader the way a mentor or a trading desk would — for the many traders
who have neither.

## The name
- **Score** ← *box score* (where you check a player's stats) → here you check
  your own trader's stats.
- **Tape** ← game *tape* / game film (reviewing your performance), and doubles as
  *reading the tape* (the buy/sell order flow). Hence "game film for traders."

## Who it's for
Serious retail futures traders (the founder's frame is NQ/MNQ intraday). They
speak in RVOL, ADR, ATR, initial balance (IB), R-multiples, EMAs, PDH/PDL. The
product does NOT apologize for that depth — but it offers a simpler surface
(below) so less advanced traders will still journal.

## The core thesis (why it's different from a P&L journal)
It grades **process and behavior**, not just outcome. Two ideas do the heavy
lifting:
1. **Execution vs. Compliance as separate axes.** Execution = did you follow your
   own entry/exit criteria per trade. Compliance = did you follow your rules
   (daily loss limit, size cap, no sizing up after a loss, cooldown, trade cap).
   This separates "good process, bad luck" from "broke discipline, got lucky."
2. **Excursion-based coaching.** MFE/MAE (in ATR units) + post-exit drift turn
   raw fills into behavior feedback: are you cutting winners early, taking too
   much heat for the profit you get, exiting at the right time, sizing stops well?

## What makes it defensible (the moat)
Not the UI — a competitor can copy screens in a weekend. The moat is the
**coaching lens**: the founder's mentors' framework + a quantified analytical
method, encoded server-side in prompts + each user's scoring profile. Guard the
methodology, not the interface. (The flagship future differentiator —
cross-trader benchmarking — is deferred; it needs a multi-tenant userbase.)

## The full loop (what a user does)
1. **Daily Prep** — read the day (day type, RVOL/ADR/ATR/IB conditions, key
   levels), write mood + trade plans; AI gives a "read" and compares what it sees
   vs. what you planned.
2. **Intraday log** — paste a chart screenshot; AI picks the instrument and
   auto-tags setups/confluences; jot why you took the trade.
3. **EOD recap** — trades clustered on a chart, MFE/MAE ratios, post-exit drift,
   session behaviors, an optional recorded-session → AI commentary, then
   "Analyze Session" → process + execution scores.
4. **Weekly review** — a coach synthesis of themes across the week.
5. **Analytics** — performance per setup / confluence / condition so you can see
   which edges actually work for you.

## Design philosophy
"Review in detail like an athlete, but reduce friction so people actually do it."
Expressed concretely as a **Highlights vs. Detail** split — a simple stats view
for entry-level / low-detail users, a fully broken-out view for serious ones.
Screenshot-to-tags and heavy auto-population exist to make rich journaling low-
effort.

## Honest state (built vs. aspirational)
- **Built and real today:** the mechanical richness — MFE/MAE, post-exit drift,
  execution/compliance scoring, auto-tag from screenshots, per-setup analytics,
  the full prep→intraday→EOD→weekly→analytics loop.
- **Still maturing:** the *judgment* layer — the coach getting smart enough to
  grade day-type selectivity, fold journal language into coaching, and give
  mentor-grade themes. It improves as a user accumulates data. Don't let the
  product over-promise a fully-formed coach before that layer is there.

## Key domain guardrails (easy to get wrong)
- Order-flow confirmation (e.g. "2 of 3 reads") is a **sizing gate** for scaling
  up, NOT a validity requirement for a trade. Never fail a normal-size trade for
  "low order flow."
- The coach is **multi-tenant**: each user's profile drives the analytical lens.
  Don't impose the founder's framework (or order flow) on a user who doesn't use it.
- Getting **stopped is not bad execution** if the idea was invalidated — the stop
  did its job. (MAE-as-heat is descriptive, not a penalty.)
```
