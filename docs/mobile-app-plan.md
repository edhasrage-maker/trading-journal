# Mobile App Plan — Review Trades On The Go

**Status:** Planning / strategy-first. **No code changes yet.** This captures scope and the build path for a **downloadable native app** whose job is *reviewing* trades away from the desk. It is downstream of the hosting decision in [`take-public-plan.md`](./take-public-plan.md) §1 — read that first for the deployment fork.

---

## 0. The core reality (read this first)

**Review is the easy half of mobile.** The cloud-hostile parts of this app — reading `.scid` market data, OBS recordings, ffmpeg frame extraction — are all about **importing/ingesting** trades. That work stays on the founder's Windows machine and is *not* part of a review app.

**Reviewing** a trade means *reading already-computed data*: the trade list, EOD recaps, analytics, the chart with entries/exits marked, day notes. All of that lives in **Supabase, which is already cloud-hosted.** A phone can reach it directly.

> So the headline blocker from the take-public plan (§0, local-file dependency) **mostly does not apply here.** A review-only mobile app sidesteps it. That's the reason this is achievable relatively cheaply.

**What it is NOT (v1):** not for logging/importing trades, not for live intraday trading, not for prep. Those are desk activities that touch local files or need a wide screen. Read-only review is the wedge.

---

## 1. Scope — what "review on the go" actually means

Ranked by how well each of the 6 screens fits a phone + how much review value it carries:

| Screen | Mobile v1? | Why |
|---|---|---|
| **Dashboard (Highlights)** | ✅ Core | The plain-English "how am I doing" summary is *made* for a phone glance. Chips + focus + recent sessions list already stack vertically. |
| **EOD recap** | ✅ Core | The main "review a day" surface: P&L, per-trade list, AI recap, day note. High value on the go. |
| **Analytics (Highlights)** | ✅ Core | Tag performance, win-rate, capture — the "what's working" read. Detailed Tape tables can defer to a phone-scroll or desktop. |
| **Weekly recap** | ✅ v1 | Week-in-review reads well as a scrollable card stack. |
| **Live chart** | ⚠️ v1.5 | Highest-value *and* hardest: lightweight-charts on a touch screen needs real work (pinch-zoom, tap-crosshair). Ship a static/simplified chart first, full interactivity later. |
| **Prep** | ❌ Later | Morning-at-the-desk activity; auto-fills from local bars. Low on-the-go value. |
| **Intraday logging** | ❌ Not v1 | Write path, touches import. Explicitly out of scope. |

**v1 = Dashboard + EOD + Analytics + Weekly, Highlights-first, read-only.** Chart interactivity is the first fast-follow.

---

## 2. The one true prerequisite — a host

A downloadable app needs a live backend. Nothing is hosted today (the app runs on `localhost`). Two sub-paths:

- **Option A — Supabase-direct (recommended for v1).** The mobile app talks **straight to Supabase** using the JS client (same anon-key + Auth the web app uses). Reads trades/analytics/recaps directly from tables. **No Next.js server needed to deploy** for pure review. Cheapest path to a working app.
  - Caveat: any read that currently happens in a Next.js API route (server-side aggregation, AI calls) must either (a) be reproduced client-side against Supabase, or (b) wait for Option B.
- **Option B — Deployed API.** Deploy the public Next.js build to a host (Vercel). The app calls the same `/api` routes the web app does — gets AI features (coach, EOD analysis) on mobile for free. More infra, but no logic duplication.

**Recommendation:** ship **v1 on Option A** (Supabase-direct, read-only, no AI-on-mobile), because it needs zero server deployment and covers the review use case. Add Option B when you want the coach/AI recaps generated *from* the phone. This also composes cleanly with the take-public §1 decision — whatever host is chosen there becomes this app's Option-B backend.

**Hard dependency:** this only works once **user-scoped RLS** exists ([take-public-plan §2](./take-public-plan.md)). Until then every user sees all rows — unacceptable for a distributed app. RLS is a launch prerequisite for *both* web-public and mobile.

---

## 3. Build path — Capacitor (recommended)

| Path | What it is | Reuses web code? | Effort |
|---|---|---|---|
| **Capacitor** ✅ | Wraps the existing Next.js/React app in a native shell → real iOS/Android binaries for the App Store / Play Store | ~95% | Low–moderate |
| React Native / Expo | True native app, its own UI, shares only data/logic | Logic only | High (2nd codebase) |
| PWA (no store) | Installable web app ("Add to Home Screen"), no store listing | 100% | Lowest — but not "downloadable from a store" |

**Recommendation: Capacitor.** It produces genuine downloadable store binaries while reusing the React you already have. The real work is **responsive tuning of the review screens**, not a rewrite. React Native's better native feel isn't worth a second codebase for a read-only review app. (A PWA is the zero-effort stopgap if you want to *feel* it on a phone before committing to the store path.)

### What Capacitor actually requires
1. A deployable build of the review surfaces (static export or pointed at Supabase-direct).
2. Responsive passes on the v1 screens (§1) — they're already Tailwind-responsive but not *tuned* for 380px: touch targets, table→card reflows, font sizes, safe-area insets.
3. Native shell config (app icon = TapeScore mark, splash, status-bar theming to `#0E0F11`).
4. Auth on device (Supabase Auth session persistence; biometric unlock is a nice-to-have).
5. App Store / Play Store developer accounts + submission (the non-code long pole).

---

## 4. Design fit — this is already half-solved

The **TapeScore rebrand + Highlights view were designed for exactly this reader.** Highlights mode is plain-English, vertically stacked, low-density — i.e. already phone-shaped. The mobile app is largely "Highlights mode in a native shell," which means the friendliness/de-jargon work in flight directly feeds the mobile experience. The brand mark/favicon SVGs already exist for the app icon.

---

## 5. Risks & open questions

- **Chart on touch** is the hardest single piece — budget real time for it, or ship a simplified read-only chart in v1.
- **AI on mobile** (coach, generate-recap) needs Option B (deployed API) + the AI rate caps from take-public §4. Defer to v1.5.
- **Offline** — do reviews need to work with no signal (on a plane)? If yes, add a local cache/sync layer (bigger scope). Assume online-only for v1.
- **Two-app maintenance** — Capacitor keeps it one codebase, but store submissions, native builds, and OS-version churn are ongoing overhead.
- **Push notifications** ("your EOD recap is ready") — a genuine mobile-native win, but Option B + notification infra. Post-v1.

---

## Sequencing (proposed)

1. **Settle hosting** — resolve [take-public §1](./take-public-plan.md) and land **user-scoped RLS** (§2 there). Hard gate for a distributed app.
2. **Responsive pass** on the v1 review screens (Dashboard, EOD, Analytics, Weekly) in Highlights mode — valuable on its own, even as phone-browser web.
3. **Capacitor spike** — wrap the responsive build, get it running on a real device against Supabase-direct (Option A). Prove the loop end-to-end.
4. **Chart-on-touch** — simplified read-only first, interactivity as fast-follow.
5. **Store submission** — accounts, icons, review process.
6. **v1.5:** Option B deployed API → AI recaps + push notifications on device.
