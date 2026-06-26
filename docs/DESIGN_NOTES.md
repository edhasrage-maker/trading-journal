# Design Notes — handoff brief for the UX/design chat

Brief for a **separate, design-focused chat.** Product strategy and the
public-launch build live elsewhere (see `STATUS_SUMMARY.md`, `DEPLOYMENT.md`,
`LAUNCH_TIMELINE.md`). These design docs currently live on the
`feat/public-testing-mvp` branch.

## Priority caveat (read first)
Design polish is a **pre-public-launch** task, **not pre-beta.** The beta ships
without it — the trader audience judges signal over gloss. So this workstream is
**parallel/secondary** to the launch critical path (multi-tenant deploy +
importer + validation). Don't let design block the beta.

## Product in one line
An AI trading journal/analytics tool for **serious futures traders**. Name is in
the **"Acuity" direction**, not final. Wedge: day-one value + capture/MFE-MAE
depth + condition intelligence.

## Current UI (from a real dashboard screenshot)
- **Dark, dense, data-heavy trading dashboard.** Near-black background, dark-slate
  cards, **stock-blue accent**, system/Inter-ish type, lucide icons.
- Dashboard = equity curve + daily-results bar chart, 5 stat cards (P&L, Day Win%,
  Trade Win%, Avg MFE/MAE w/ pts/$/ATR toggle, Execution/Compliance), and a
  **Recent Days table** with execution badges, a Process check, MFE/MAE in ATR,
  MFE-Realized %, and day-type tags per row.
- Stack: Next.js + Tailwind + lightweight-charts + Recharts + lucide.

## VERDICT — what to PRESERVE
It reads as **trader-built, not AI-slop** — the data density + domain-specific
columns are a real strength, and traders *like* dark, dense data tools (Sierra,
NinjaTrader, Bloomberg). **Do NOT genericize it into a minimal/clean SaaS look.**
Keep the dark, dense, "serious instrument" feel.

## The "indie/templated tells" to fix (goal: *intentional product*)
1. **Stock dark-slate Tailwind palette + default blue accent** — no distinct identity.
2. **No brand presence** — top-left just says "Dashboard"; no logo/name.
3. **Default typography**, flat hierarchy (stat cards + rows feel same weight).
4. **"Coming soon" stub pages** (Settings → Tags, Stats) — amateur tell; hide them.
5. **Emoji-as-icons** anywhere — use lucide consistently.

## Brand layer to design (high-leverage)
- **Logo + product name** top-left.
- **One distinctive accent color** to replace stock-blue (own a color).
- **A chosen typeface** (consider a distinct display face + a mono/tabular face for
  numbers) + stronger visual hierarchy.
- A small **documented design system** (palette tokens, type scale, spacing,
  component states) so it stays consistent, not ad-hoc.

## UX nits (real clarity bugs, not aesthetics)
- **"MFE Realized %" showing −638% / −22% in red looks *broken*** to a newcomer — a
  capture/give-back figure that extreme reads as a bug. Cap/format/tooltip it.
- **Red "Trade Win % 38%" on a profitable stretch over-alarms** — color by sensible
  thresholds, not just <50%.
- **Empty dashboard for a new user has no "import your trades" CTA** (first-run gap)
  — overlaps with the launch build; coordinate, don't double-build.

## Constraints / working notes
- Keep it trader-credible (dark, dense, serious). Distinctive ≠ minimal.
- Design changes go on a **separate branch**; coordinate with the launch-build
  branch (`feat/public-testing-mvp`) to avoid conflicts.
- **No browser in the Claude env** — propose changes; the user verifies via screenshots.

## Suggested first step
Propose **2–3 distinct visual-identity directions** (accent color + typeface +
overall vibe) for the user to react to on a screenshot — then spec the chosen one
as a small design system, and fix the two UX nits.
