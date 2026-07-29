# Pt 11 — Coaching continuation handoff

Written 2026-07-28 at the end of the deep-dive / trust-layer session. Paste the
prompt block below into a new thread to pick the coaching work back up.

The deep-dive battery, the registry wiring and the EOD trust layer all shipped;
what follows is what's left, in the order I'd take it.

---

```
Pt 11 — COACHING CONTINUATION (TapeScore). New thread; the deep-dive battery, the
registry wiring and the EOD trust layer all shipped — this is what's left.
Repo: D:\Documents\Trading\Trading Journal — branch live-server-version (deploys to tapescore.app).

READ FIRST (memory): project-deep-dive-battery, entry-rubric-owner-vs-public,
tapescore-trade-data-gotchas, db-target-prod-not-dev, prod-db-multitenant-rls,
ux-reduce-confusion-first.

SHIPPED THIS SESSION (all pushed, 13 npm-test suites green):
- Deep dives: stopped-reversal, scale-out-ev, time-of-day (+ stats.ts, exit-events.ts).
  Registry (src/lib/deep-dive/registry.ts) wired into BOTH coach paths — opener ranking
  via /api/coach/suggestions, and on-ask keyword routing that injects the computed numbers
  into the per-turn system block (after the prompt-cache breakpoint).
- Dives also render in "what your data already says" (/api/first-read + Patterns page) via
  mergeDiveInsights — a dive SUPERSEDES the contrast engine's shallower read of the same
  subject, and takes at most 2 of the slots.
- Entry rubric split owner/public; criteria 6/7/8 NOT SCORED publicly; missing journaling
  is N/A, never a fail. Criterion 6 fixed — it passed only "Break of Clusters/Bubbles" while
  the entry_model library has six models, so four declared triggers were failing.
- Instrument-aware size rails: 5 MNQ / 10 MES base, 10 / 20 on A+ (sizeCapFor). Fixed a live
  P3 bug where symbol-blind caps made every correctly-sized 10-lot MES trade a breach.
- Post-exit magnitude now ×ATR not R; perfect exits no longer render "—" (exitedAtExtreme).
- EOD trust layer: structure_5m_regime rendered on the trade line, B8 "You cannot see the
  tape", session-facts.ts (precomputed tallies/gaps/tag counts/MFE), checkFactClaims (A9),
  B9 NEVER RECALCULATE + B10 NO INVENTED TRENDS.

THE FINDING THAT DROVE THE TRUST WORK — read before touching the EOD prompt:
An audit of the 2026-07-28 analysis against the DB found ~HALF its specific numbers wrong,
and the pattern was diagnostic: everything the model READ from a field was correct;
everything it CALCULATED in prose was suspect ("3/3 ES trades hit TP" → 2/3; "T1→T2 was
60s" → 44s; "T3 lists 4-7 confluences" → 2; "0.5 pts favorable" → 2.0). It also FABRICATED
market state it has no feed for ("a tape that had stopped supporting the bullish bias")
while the trader's own tag on those trades said "Follow LTF structure". ALWAYS verify a
model claim against the DB before accepting it — and note two errors the checker still
can't catch: it praised "size discipline held" on trades the trader tagged Oversized, and
called an 84-second re-entry "patience" while tagging the same trade Revenge Trading.

WHAT I WANT TO TACKLE (my order):
 ① WIRE A9 INTO THE LIVE PATH. checkFactClaims is built + tested but only the eval harness
    can reach it. Decide: does a violation block the save, annotate the row, or log only?
    My lean is annotate + log first (never block — a false positive must not cost a session).
 ② CROSS-CHECK AI CLAIMS AGAINST MY OWN TAGS, deterministically. Praising a trade I tagged
    Oversized/Revenge/FOMO is a contradiction that needs no judge model — it's a set
    intersection between what_worked[] trade refs and tags_json.mistakes.
 ③ A Tier-B judge rule for FABRICATED MARKET STATE (B8's machine mirror). The prompt rule
    exists; there is no check. Phrases: "the tape", "structure invalidated", "buyers dried
    up", "no confirmed higher-low" — anything describing price action between entries.
 ④ SEVERITY IS DOLLAR-NORMALIZED and shouldn't be. Dive severity uses raw impact ÷ $2,500,
    so a 15-30 lot account systematically outranks a 1-2 lot one for the SAME behavioral
    leak. My locked design principle is R-normalized / personalized claims. The $ figure
    stays in the copy; the RANK should be R or a share of the account's own P&L.
 then: resolveCaptureBenchmark(profile, trade) so dives read exit style from
    ScoringProfile.style; and the onboarding confirm-card UI (inferTradingStyle is built,
    PURE and tested — there is no UI).

OPEN — NEEDS ME (user), not code:
- Personal DB (gppxmkvceyrnljbhfwgl) is 6 migrations behind. Two SQL files were generated
  (part 1 additive, part 2 the guarded renames). PROD IS CURRENT — verify before assuming.
- After part 2: a condition_lookup refresh (the rename repurposes a dead column, it does
  not recompute it).
- Personal DB tag library is pre-merge; running structure_confluence_tags there recreates
  the duplicate pairs already cleaned off prod. scripts/merge-tag-dupes-public.ts is
  hardcoded to .env.public-feed and needs a --db personal flag.
- 20260727_custom_tag_categories on PROD is unverified (drops a CHECK; not detectable over
  REST).
- Re-run Analyze Session on a recent day: does the facts block + B8 actually bind? If the
  numbers come back right, prompt-level fixes suffice; if not, A9 will name which ones.
- stopped-reversal still returns null in the coach — no server-side ordered-path data. Needs
  a migration (5 path fields) + tick backfill. Deliberately parked.

PERF NOTE: both coach paths fetch the FULL trade book (5.7k rows on the owner account).
The opener runs it in parallel with the signal queries; on-ask only fires on a keyword
match. If the panel feels slow to open, that's the cause and a cached rollup is the fix.

CONSTRAINTS: tsc --noEmit + eslint + npm test clean on changed files; commit in logical
chunks with pathspec (git commit -- <paths>) — a parallel session is active on this branch,
never blind git add; push live-server-version; co-author tag
"Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>". Scripts importing @/ aliases MUST
run via npx tsx; wrap top-level await in async main(). PROD DB IS MULTI-TENANT and the
service-role key BYPASSES RLS — scope every write to user_id (edhasrage = fa3fb352) and
verify on tapescore.app, not localhost. Any EOD prompt edit: run npm test — the
PROMPT_ANCHORS drift guard catches a rule silently disappearing (it caught "outcome bias"
vanishing when criterion 7 was dropped).

DON'T: trust a memory note without re-verifying (the "day_stats migration never run" note
was stale — it was applied); let an unconfirmed AI tag affect a score; add a prompt rule
without an anchor; merge a tag without grepping the codebase for the label string first
(deleting one silently disabled follow auto-tagging for a day).
```

---

## Why this order

**② and ③ before ①.** The audit showed the *contradictions* damaged trust more than
the arithmetic did. A wrong gap in seconds reads as a slip; praising a trade the
trader flagged `Oversized` reads as the tool never having opened the journal.

**④ is invisible today and won't stay that way.** Dive severity ranks on raw
dollars, so the owner account (15–30 lots) outranks a 1–2 lot account for an
identical behavioural leak. Nothing looks wrong while there is one account with
real volume; every finding mis-ranks the moment there are two.

## Verification discipline this session earned the hard way

- A claim is worth what its source is worth. Check model output against the DB
  before repeating it — half of one analysis was wrong, and it read fluently.
- Re-verify memory notes before acting. Two were stale: `day_stats` was recorded
  as never run (it was applied), and a `condition_lookup` probe hit the wrong
  table and reported a missing migration that was present.
- Grep for a tag label before merging it. `Follow LTF structure` looked like seed
  junk next to a 108-use variant; it is the string
  `/api/trades/suggest-tags` emits, and deleting it disabled follow auto-tagging
  for a day. Canonical = the auto-detectable label, not the most-used one.
- Non-idempotent SQL doesn't belong in a batch with idempotent SQL. One
  `ALTER TABLE … RENAME COLUMN` (no `IF EXISTS` form) rolled back five additive
  migrations that had nothing to do with it.
