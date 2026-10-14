/**
 * The finding callout — the one carry-over finding surfaced as a headline, its
 * evidence and its "Do next" ("Keep setting the far target — it is carrying
 * your results."), plus the "You committed to this before the open" card it
 * turns into once it is committed to in Prep.
 *
 * Hidden for now on the day's Recap and on the Dashboard (founder, 2026-10-13:
 * "not sure if this is helpful"). Only the display is off: Prep still offers and
 * saves the commitment, and the week / month recaps still read it. Set this back
 * to true and every surface returns exactly as it was.
 *
 * Typed `boolean`, not `false`, so the branches it guards stay type-checked.
 */
export const SHOW_FINDING_CALLOUT: boolean = false
