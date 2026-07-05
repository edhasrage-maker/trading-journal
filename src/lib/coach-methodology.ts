/**
 * Shared coaching analysis methodology — the diagnostic lens the AI applies
 * when analyzing trader performance. Kept in ONE place so the coach chat, the
 * weekly recap, and (selectively) the EOD analysis reason consistently and
 * can't drift.
 */

/**
 * Units/size discipline — capture must never be judged in a single unit,
 * because size decouples $ / points / ×ATR. Safe to inject ANYWHERE MFE/MAE
 * capture or "left on the table" is discussed, INCLUDING the EOD rubric
 * narrative (it adds framing without touching the scoring math).
 */
export const CAPTURE_UNITS_DISCIPLINE = `CAPTURE IN MULTIPLE UNITS — never judge MFE capture or "left on the table" in a single unit. Read $, points, AND ×ATR together: size decouples them, so a big ×ATR capture on small size can be small $, and a smaller ×ATR capture on big size more $. $ is the goal — don't equate "captured a lot of ATR" with "made money", and don't call a small-×ATR / big-$ trade a poor capture.`

/**
 * Full top-down diagnostic order for the COACHING surfaces (coach chat +
 * weekly recap). NOT for the EOD rubric: that scores one day against fixed
 * safety-rail + execution rules, so "foundation-first" and "heat vs reward"
 * don't belong there — and the ruleset deliberately does NOT score MAE heat
 * (v1.4 amendment 4). EOD gets CAPTURE_UNITS_DISCIPLINE only.
 */
export const ANALYSIS_APPROACH = `HOW TO ANALYZE (diagnostic order — top-down; don't skip levels):
1. FOUNDATION FIRST. Before critiquing individual trades, locate the problem at the right altitude: does the trader have a defined playbook, entry rules, and — critically — a PROFIT-TAKING system (targets, a scale-out rule)? "I leave money on the table" is usually a MISSING exit framework, not a bad read. If the foundation is clearly in place (defined setups, stated invalidations, a target method — the profile usually tells you), acknowledge it in ONE line and move on; do NOT interrogate a trader who obviously has a system. If it's missing or vague, name the gap and fix that first — per-trade optimization is premature until the scaffolding exists.
2. HEAT vs REWARD. Compare MAE (heat taken) against MFE (favorable move available): are they routinely taking as much or more heat than they gain?
3. CAPTURE, READ AGAINST HEAT. Of the available favorable move (MFE), how much do they bank — and judge it ALWAYS against the heat taken (MAE), never alone: capturing 1R while enduring 2R of heat is a poor trade even if "captured"; capturing a bit less on tiny heat is a clean read. Low capture as a persistent THEME (not one trade) is an exit-system problem, not a one-off.
4. ${CAPTURE_UNITS_DISCIPLINE}

Close improvement advice with ONE prioritized, testable adjustment they can try — not a laundry list.`
