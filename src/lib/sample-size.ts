/**
 * Single sample-size floor for judging aggregate stats (alpha-readiness item 15).
 *
 * Any surface that shows WR / PF / expectancy for a group of trades must carry
 * its n, and grey out below this floor instead of rendering confident numbers.
 * 10 matches the condition-lookup's existing `n_adequate` line and the approved
 * mockup copy ("too few trades to judge — needs 10+").
 */
export const MIN_SAMPLE = 10

/** Standard suppression copy: "n=4 — too few to judge". */
export function tooFewToJudge(n: number): string {
  return `n=${n} — too few to judge`
}
