# AI output constraints + eval set — the "trust layer" (Pt 21 ticket 7)

**Status:** APPROVED with defaults (2026-07-18). Claude drafted this from the
codebase since no written ticket existed; owner approved building it with the
default answers. Being built in the phase order at the bottom.

**Resolved (defaults):** Q1 EOD first, coach a fast-follow. · Q2 Haiku judge for
Tier B. · Q3 goldens = a mix of a few real recorded EOD outputs + synthetic edge
cases. · Q4 eval-only — no runtime validator this pass. · Q5 local `npm run
eval`, no CI gate yet.

## Problem

TapeScore's AI outputs (EOD analysis, coach chat, prep analysis, weekly recap,
…) are the product's trust surface: a trader acts on what the coach says. Today
we defend that surface two ways —

1. **Deterministic overrides** (`applyDeterministicOverrides` /
   `computeDeterministicRules` in `eod-prompt.ts`): the safety rails P1/P3/P4/P5,
   Profit Factor, mfe_capture, and the execution composite are RECOMPUTED in code
   and overwrite whatever the model claimed. The model can't lie about the math.
2. **Prose constraints** (the `NARRATIVE DISCIPLINE` sections + `genericRulesetBlock`
   in `eod-prompt.ts`): ~7 rules against outcome bias, causation-vs-correlation,
   caveat-attached rail passes, inflated structural terms, time-of-day-as-mistake,
   fabricated capture units, etc.

The gap: **nothing automatically checks that (2) actually holds, or that (1)
actually fired.** A prompt edit (or a model swap) can silently regress the coach
back into "your missing OF caused the loss" or "you scratched a winner," and
we'd only find out from a user. There is no eval set and no output validator.

**Ticket 7 = close that gap:** machine-checkable output constraints + an eval
set that asserts them, so prompt/model changes can't quietly erode trust.

## Scope

**In scope (this pass):** the EOD analysis output (`buildEodPrompt` /
`parseEodResponse`) as the flagship, plus the coach chat reply. These are the
highest-stakes, most-read outputs and already carry the most constraints.

**Out of scope (follow-ups):** the extraction routes (`extract-*`,
`suggest-tags`, `spell-check`) — low-judgment, structured, lower trust stakes.
Note them for a later pass; don't build eval coverage for them now.

## The constraint catalog

Two tiers, by how they're checked.

### Tier A — structural (deterministic, no model call)

Checkable on any output blob with pure code. Fast enough to run in CI on every
push and against recorded golden outputs.

| # | Constraint | Check |
|---|---|---|
| A1 | Valid JSON, no markdown fences | `parseEodResponse` succeeds; output starts `{` ends `}` |
| A2 | Schema conformance | every required key present; unknown top-level keys flagged |
| A3 | `process.verdict ∈ {Compliant, Breach}` | enum membership |
| A4 | Scores in range | `score ∈ 1..10`; axis metrics `∈ [0,1]∪{null}`; `profit_factor ≥ 0` |
| A5 | Headline caps | top headline ≤14 words, no digit-group that reads as a $ P&L, never the literal "Compliance"; process/execution headline ≤15 words |
| A6 | `notes` are narrative, not a calc trace | reject per-trade arithmetic (`/T\d+\s+M[AF]E\s*=/`), composite formulas (`/0\.\d+\s*\*\s*0\.\d+/`), "Reporting X = Y" lines |
| A7 | Deterministic override AGREEMENT | after `applyDeterministicOverrides`, `process.per_rule[P1/P3/P4/P5]` and PF/mfe_capture/composite equal the code-computed values (asserts the override actually ran and wasn't bypassed) |
| A8 | Bullet discipline | `what_worked ≤4`, `mistakes ≤5`, `patterns ≤4`, `next_session_focus ≤3`; each bullet 1 sentence |

### Tier B — behavioral (needs a model judge)

Semantic; can't be regexed reliably. Run behind a `--live` flag with a cheap
judge model (Haiku) prompted to detect ONE specific violation at a time and
return `{violated: boolean, evidence: string}`.

| # | Constraint | Failure it catches |
|---|---|---|
| B1 | No outcome bias | "would have hit target", "scratched a winner", judging the exit by post-exit price |
| B2 | Causation vs correlation | "the missing OF **caused** the loss", "1/3 OF **led to** the stop" |
| B3 | No caveat-attached rail pass | "P4 passes **BUT** the rush back bears monitoring" |
| B4 | Risk-off scratch is not a mistake | a disciplined two-way-tape scratch appearing in `mistakes[]` |
| B5 | Structural terms literal | "active downtrend" / "breakdown" / "acceptance" used without the structural precondition |
| B6 | Time-of-day never a breach | an entry time listed in `mistakes[]` or as a rule breach |
| B7 | Vocabulary-agnostic emotion | criterion 9 judged on state, not a literal tag word (the #1 fix we just shipped — lock it in) |

Each B-rule maps 1:1 to an existing `NARRATIVE DISCIPLINE` rule, so the eval is
literally "does the model still obey the rule we wrote."

## Where the constraints live (no-drift rule)

Extract the checkable pieces into **`src/lib/ai-constraints.ts`**:

- the Tier-A regex/predicate catalog + `checkStructural(parsed): Violation[]`,
- the Tier-B rule definitions (id, human description, judge prompt),

so BOTH the eval harness AND (optionally) a runtime post-parse validator import
the same source of truth. The prompt prose in `eod-prompt.ts` stays the
authoritative instruction; `ai-constraints.ts` is the machine mirror. A drift
guard (Tier A) asserts each constraint's key phrase still appears in the prompt,
so a rule can't be deleted from the prompt without failing the eval.

## The eval harness

`scripts/eval-ai-output.ts` + fixtures in `evals/cases/*.json`.

**Fixture shape:**
```jsonc
{
  "name": "risk-off-scratch-on-deteriorating-read",
  "tier": "B",                    // which checks are meaningful here
  "input": { "trades": [...], "eodNotes": "...", "scoringProfile": {...} },
  "golden": { /* recorded model output, optional — enables Tier-A offline */ },
  "expect": ["A1","A3","B1","B4"] // constraint ids that MUST hold
}
```

**Two run modes:**
- **Offline (default, CI-safe):** run Tier-A checks against each fixture's
  recorded `golden` output — zero API calls, deterministic, fast. Plus the
  prompt-drift guard. This is what gates CI.
- **Live (`--live`, needs `ANTHROPIC_API_KEY`):** build the real prompt per
  fixture, call the model, run Tier-A on the fresh output AND Tier-B via the
  judge. Used before a prompt/model change ships; not in CI (cost + flakiness).

**Exit non-zero on any `expect` violation** so it can gate a pre-push hook or CI
job. Prints a per-case pass/fail table + the offending evidence string.

**Seed corpus (~10 cases)** covering the live failure modes:
clean compliant day · outright breach day · risk-off scratch · hybrid
structural+PnL exit · 1/3-OF base-size entry · single-LH structure · MAXRAGE /
compromised-emotion day · public empty-profile (all rails untracked) · own-vocab
stable emotion ("composed") · a no-trades day.

## Optional: runtime enforcement

A `validateEodOutput(parsed)` called post-parse in `analyze-eod/route.ts` that
runs Tier-A and **logs** violations (Sentry/console) without blocking the
response — a production tripwire complementing the offline eval. Could later
escalate to light auto-repair (strip a fence, truncate an over-long headline).
**Decision needed:** log-only now, or also repair? (Recommend log-only first.)

## Build order (each shippable + verifiable)

1. **`ai-constraints.ts`** — Tier-A `checkStructural` + the regex catalog + the
   Tier-B rule/judge definitions. Unit-test the regexes against hand-written
   good/bad strings. (No behavior change; pure lib.)
2. **`scripts/eval-ai-output.ts` offline mode** + 3–4 seed fixtures with recorded
   goldens. Wire an `npm run eval` script. Green baseline.
3. **Grow the corpus to ~10** across the failure modes above.
4. **Live mode + Haiku judge** for Tier B, behind `--live`.
5. **(Optional) runtime `validateEodOutput` log-only** in the EOD route.
6. **(Optional) CI/pre-push gate** running the offline eval.

Rollback is trivial at every step — the eval is additive; nothing in the
shipping path depends on it until step 5.

## Open questions (please answer inline)

- **Q1.** Flagship coverage — EOD only this pass, or EOD **and** coach chat? (Draft assumes EOD first, coach a fast-follow.)
- **Q2.** Judge model — Haiku OK for Tier B, or must the judge be the same tier as the graders (Opus/Sonnet)?
- **Q3.** Goldens — record real outputs from your own recent EOD analyses as fixtures (best signal, but they're your data), or hand-author synthetic ones?
- **Q4.** Runtime validator — build the log-only tripwire this pass, or eval-only for now?
- **Q5.** CI — is there a CI runner to gate on, or is this a local `npm run eval` discipline for now?
