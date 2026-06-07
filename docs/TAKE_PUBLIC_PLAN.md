# Take-public plan — working draft

Strategic notes from the take-public planning conversation. Captures decisions
made so far and open questions. Use this as the read-cold reference when
picking the conversation back up.

For the narrower "save for public" feature inventory see `PUBLIC_VERSION.md`.

## Status

In progress. Distribution model and target audience are committed. Pricing
tiers, broker import scope, and Rithmic licensing are open.

## Phone-captured notes

Quick thoughts captured from phone go in `PHONE_NOTES.md` (same directory).
On the next desktop Claude Code session, process and clear that file —
the standard prompt is *"read `docs/PHONE_NOTES.md`, integrate anything
relevant into this plan, then clear the inbox."*

---

## Decisions committed

### 1. Distribution model: hosted SaaS

Open-source self-host was the initial recommendation but is dead on arrival
for adoption. "Install Node, set up Supabase, get an Anthropic key, configure
env vars" loses 95% of users before the first screen. Sign up → log in →
import → value within 5 minutes is table stakes. We host.

Implications:
- We absorb Anthropic API costs (no BYO key)
- Prompts stay private (real but not the biggest piece of IP — see §IP below)
- Need billing infrastructure from day one
- Multi-tenancy migration on every table (`user_id` column + RLS scoped to
  `auth.uid()`)

### 2. Pricing model: freemium with premium tier

- Video AI commentary is premium (it's the most expensive AI feature per
  user-day, and a clear "wow" gateable feature)
- Cross-trader benchmarks (median MFE/hold-time/etc.) are premium — they
  require multi-tenant data anyway
- Free tier needs to be useful enough to retain, capped enough to convert

Concrete tiers TBD. Rough sketch:
- Free: journal, basic tags, EOD AI on a daily cap
- Paid (~$30/mo): unlimited AI, full analytics, prep AI scoring
- Premium (~$60-100/mo): video commentary, cross-trader benchmarks, advanced
  analytics

### 3. Target audience: serious futures traders

Not broad retail. The users we know use TradingView, NinjaTrader,
Quantower, and MotiveWave — all serious/professional futures-leaning
platforms. They likely execute via Tradovate, AMP Futures, NinjaTrader
Brokerage, or similar futures-focused brokers.

Implications:
- This audience pays $30-200/mo for tools already (Rithmic feeds, platform
  licenses, eval accounts). $30-100/mo for a great journal is normal
- They tolerate some setup friction (already configured Rithmic, broker
  permissions, etc.)
- Smaller TAM than "all retail" but much higher LTV, lower CAC, sharper PMF
- Sierra Chart is in the same family but used by very few — it becomes a
  power-user feature, not the foundation
- Stocks/options audience is NOT the launch focus

### 4. Chart data vs trade fills are independent problems

These were initially conflated. They share only a join key
(`symbol, date, time-range`). Can be built and shipped on independent
timelines.

---

## Where the IP actually lives

Ranked by load-bearing-ness:

1. **The opinionated schema and framework.** The 7-category tag taxonomy
   (setups / confluences / order flow / trade management / day_type /
   mistakes / emotions), RVOL/ADR/ATR auto-bucketing, prep→intraday→EOD
   discipline, exchange-anchored session calcs. This is the hardest to
   replicate.
2. **Local-data integrations.** Reading `.scid` directly and OBS frame
   extraction. Few competitors will build this. But it's niche to the
   subset of users who run those tools locally.
3. **The AI prompts.** Real but lesser. Encode prep rubric, EOD grading,
   per-trade analysis structure. Anyone with the repo can copy them.
4. **Cross-trader benchmarks (future).** Compounds with users. The moat that
   gets stronger over time.

Conclusion: the prompts alone aren't worth gating the whole project on. The
framework is more valuable and would be implicit in the schema either way.

---

## Cost math (per-user/month)

Sonnet 4.6 pricing: $3/M input, $15/M output.

Per active trading day estimate:

| Route | Tokens (in/out) | Cost |
|---|---|---|
| analyze-prep | 5k / 5k | $0.09 |
| analyze-eod | 20k / 5k | $0.14 |
| per-trade summary × 4 | 8k / 4k | $0.08 |
| video commentary × 4 (with image frames) | 20k / 4k | $0.12 |
| extract-context (screenshots) | 3k / 1k | $0.02 |
| **Per day** | | **~$0.45** |

| Cost line | Light user / mo | Active user / mo |
|---|---|---|
| Anthropic (with caching, free-tier limits) | $1 | $5-7 |
| Market data (cached, amortized) | <$0.50 | <$1 |
| Supabase | <$0.50 | $1 |
| Vercel/edge hosting | <$0.20 | $0.50 |
| **Total COGS** | **~$2** | **~$8-10** |

Video AI is the biggest swing factor (image tokens are real input tokens).
Premium-only restriction is what keeps premium COGS sustainable.

If Rithmic API integration lands (see §Rithmic insight), market data cost
drops to near-zero for connected users.

---

## Login & data storage

Already have most of this — just need to enable multi-tenancy:

- **Auth:** Supabase Auth (already integrated). Email/password + magic link
  out of the box. Add Google OAuth in ~10 minutes.
- **Per-user data:** add `user_id` column to every table; switch RLS from
  `auth.role() = 'authenticated'` to `auth.uid() = user_id`. Single migration
  pass over ~14 tables.
- **Database:** Supabase Postgres. Pro tier ($25/mo) handles well past
  hobby; storage scales with usage.
- **Files:** Supabase Storage for screenshots and OBS frames.

---

## Trade fills — strategy

Three real paths. CSV first, OAuth/API for high-leverage brokers second,
specialty integrations third.

### MVP: CSV upload

Universal — every broker exports trade history. Friction is one click +
drag-drop, repeated per session.

Recommended importer order for the launch audience:

| Source | Why |
|---|---|
| Tradezella passthrough | Already done; catches users who already aggregate |
| NinjaTrader Trade Performance CSV | Most-used platform in the segment |
| Tradovate CSV | Most-used futures broker behind NT/TradingView users |
| Quantower CSV | Smaller but committed |
| MotiveWave CSV | Smaller, analyst-leaning |

Caveat: we're reasoning about what these platforms *can export* — actual
schema/quirks need to be verified by collecting sample exports from the
network before committing to "easy."

### Phase 2: Tradovate API + Rithmic API

The killer-feature path. Connect once → auto-sync trades daily, zero
ongoing friction. See §Rithmic insight below.

### Phase 3: NinjaTrader/Quantower/MotiveWave local-DB read

Via a small bridge daemon for power users. Same shape as the Sierra `.scid`
reader. Optional, not blocking.

---

## Chart bars — strategy

Audience is futures-heavy, so:

- **Polygon.io is wrong** for this audience (stocks-focused)
- **Databento is right** — has CME futures data, pay-per-byte. Aggressive
  caching in the existing `ohlcv_bars` table amortizes cost across users.
- **Rithmic/CQG API via user credentials** is the real cost-killer for
  prop-firm users — see below.

Existing `lightweight-charts v5` UI doesn't change. Just the source.

---

## The Rithmic / CQG / Lucid insight

Researched and confirmed. Lucid (the prop firm) gives free CME data to
non-pro eval traders — but more importantly, this is the standard pattern
across the entire prop-firm-eval ecosystem (Topstep, Apex, Take Profit
Trader, MyFundedFutures, Tradeify, FundingPips, etc.).

That data is routed through either **Rithmic** or **CQG**, and both expose
public APIs designed for third-party app integration:

- **R|PROTOCOL API** — WebSocket + Protocol Buffers, language-agnostic.
  Exactly the right shape for a web app.
- **CQG WebAPI** — same idea, for CQG-routed users.

For users with a Rithmic or CQG account (which is nearly every serious
futures prop-firm trader), the journal could:

1. Connect via the user's own credentials
2. Pull historical bars on demand for symbols they traded — at zero data
   cost to us, since it's their feed
3. Auto-sync trade fills (Rithmic exposes execution data, not just market
   data)
4. Stream live bars during prep

This is the long-pole feature but reframes the cost picture entirely:

| | Before | After Rithmic integration |
|---|---|---|
| Our data cost per user | Pay Databento | ~$0 for connected users |
| Friction | "Connect your broker" | "Connect your prop-firm feed" — one click |
| Audience fit | Generic futures traders | Specifically the prop-firm-eval audience |

The prop-firm-eval audience is large and growing fast. Marketing as **"the
journal for prop-firm traders — connects directly to your eval feed, no
broker hookup, no manual import"** is a sharp wedge.

### What we DON'T know yet

- Rithmic API licensing terms and fees — not public, requires direct
  outreach
- Whether Lucid/other prop firms restrict third-party API access on user
  accounts (likely allow it since R|Trader Pro uses the same API, but
  unconfirmed)
- Whether Rithmic's data license under user credentials permits the kind
  of display the journal needs (almost certainly yes, but fine print
  matters)

### What we know we CAN'T do

Use a single eval account (ours) to source data for all users. CME data
redistribution is prohibited; CME audits this. The data has to come from
each user's own credentials.

---

## What needs building vs what exists

| Component | Status |
|---|---|
| Auth (Supabase) | Exists; needs per-user RLS migration |
| Journal core (trades, tags, daily flow) | Exists |
| Multi-tenancy (`user_id` everywhere) | Need — single migration |
| Tradezella CSV import | Exists |
| NinjaTrader CSV importer | Need |
| Tradovate CSV importer | Need |
| Quantower / MotiveWave CSV importers | Phase 2 |
| Databento integration + bar cache | Need |
| Rithmic API integration (R|PROTOCOL) | Phase 2 — start licensing now |
| CQG WebAPI integration | Phase 3 |
| Stripe / billing + tier gating | Need |
| Free-tier limits enforcement | Need |
| Anthropic per-user usage tracking | Need (`metadata.user_id`) |
| Cross-trader benchmarking | Future (after multi-tenant + critical mass) |
| Sierra `.scid` bridge daemon | Future (power users) |
| OBS commentary (premium gating) | Exists; needs gating |

---

## Open questions

1. **Pricing tiers — exact numbers.** Free / mid / premium pricing and what
   each unlocks. Need to validate against competitor benchmarks (Tradezella,
   TraderSync, Edgewonk, Chartlog) and willingness-to-pay in target segment.
2. **Broker import order.** Which 3 CSV importers ship at MVP.
3. **Rithmic licensing outreach.** When to start, what to ask for.
4. **Sample export collection.** Ask network for NT/Tradovate/Quantower/
   MotiveWave CSV samples to validate parser effort estimates.
5. **Brand and positioning.** "Journal for prop-firm traders" is the sharp
   wedge — but the product name, landing page, and copy aren't drafted.
6. **Beta/launch sequencing.** Closed beta with the network → broader open?
   Single-platform launch (NT-first) → broaden?

---

## Open product-strategy questions still on the table from earlier

- Process vs Grade scoring redesign (see `feedback_process_vs_grade_paused.md`).
- Whether benchmarking opt-in is a paid feature, a free feature for
  contributors, or both tiers.

---

## Memory snapshot (for continuity)

Local memory files capturing this work:

- `project_take_public_planning.md` — original scoping (pre-decisions)
- `project_take_public_benchmarking.md` — cross-trader benchmarking idea

These memory files are local to the machine they were written on
(`C:\Users\lamed\.claude\projects\…`). They don't sync across machines —
that's what this doc in the repo is for.
