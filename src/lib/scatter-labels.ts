/**
 * Where to put a dot's name label on the dashboard's TapeScore vs Profit chart
 * so it doesn't sit on another dot (founder, 2026-11-06: "-$413 Oct 29" was
 * printed under a neighbouring dot).
 *
 * Each label tries eight spots around its own dot — right, left, above,
 * below and the four diagonals — and takes the one that covers the least of:
 * other dots, labels already placed, fixed obstacles (axis tick text, the
 * "Strong 70+" tag) and the area outside the chart. Ties go to the earlier
 * spot, so a label with room keeps the plain right/left look.
 *
 * Pure pixel geometry: the caller measures the plot and estimates each
 * label's width. Labels are placed in the order given, so pass the most
 * important first; it gets the best spot.
 */

export type LabelSpot =
  | 'right' | 'left' | 'above' | 'below'
  | 'above-right' | 'above-left' | 'below-right' | 'below-left'

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Dot radius and the gap between a dot and its label, in px. */
const R = 7
const GAP = 6
/** One line of 12px label text. */
export const LABEL_H = 16

/** The box a label of width `w` covers in `spot` beside a dot centred at (x, y). */
export function labelRect(spot: LabelSpot, x: number, y: number, w: number): Rect {
  const side = R + GAP          // 13: beside the dot
  const diag = GAP              // 6: tucked against a corner
  switch (spot) {
    case 'right': return { x0: x + side, x1: x + side + w, y0: y - LABEL_H / 2, y1: y + LABEL_H / 2 }
    case 'left': return { x0: x - side - w, x1: x - side, y0: y - LABEL_H / 2, y1: y + LABEL_H / 2 }
    case 'above': return { x0: x - w / 2, x1: x + w / 2, y0: y - R - 4 - LABEL_H, y1: y - R - 4 }
    case 'below': return { x0: x - w / 2, x1: x + w / 2, y0: y + R + 4, y1: y + R + 4 + LABEL_H }
    case 'above-right': return { x0: x + diag, x1: x + diag + w, y0: y - R - 2 - LABEL_H, y1: y - R - 2 }
    case 'above-left': return { x0: x - diag - w, x1: x - diag, y0: y - R - 2 - LABEL_H, y1: y - R - 2 }
    case 'below-right': return { x0: x + diag, x1: x + diag + w, y0: y + R + 2, y1: y + R + 2 + LABEL_H }
    case 'below-left': return { x0: x - diag - w, x1: x - diag, y0: y + R + 2, y1: y + R + 2 + LABEL_H }
  }
}

/**
 * CSS that puts the label in `spot`, for a label absolutely positioned inside
 * the dot's own 14×14 box. Mirrors `labelRect` exactly.
 */
export function labelStyle(spot: LabelSpot): Record<string, string | number> {
  const side = R + GAP + R       // 20: from the box edge past the gap
  const diag = R + GAP           // 13
  const vert = 2 * R + 4         // 18
  const vdiag = 2 * R + 2        // 16
  switch (spot) {
    case 'right': return { left: side, top: '50%', transform: 'translateY(-50%)' }
    case 'left': return { right: side, top: '50%', transform: 'translateY(-50%)' }
    case 'above': return { bottom: vert, left: '50%', transform: 'translateX(-50%)' }
    case 'below': return { top: vert, left: '50%', transform: 'translateX(-50%)' }
    case 'above-right': return { left: diag, bottom: vdiag }
    case 'above-left': return { right: diag, bottom: vdiag }
    case 'below-right': return { left: diag, top: vdiag }
    case 'below-left': return { right: diag, top: vdiag }
  }
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))

const area = (r: Rect): number => (r.x1 - r.x0) * (r.y1 - r.y0)

/**
 * Pick a spot for each label.
 *
 * `points` are every dot on the chart (labelled or not), in px within the
 * plot. `labels` are the dots to name, most important first, with each
 * label's width. `prefer` says which side a label tries first ('left' near the
 * right edge, so it reads into the chart).
 */
export function placeLabels(
  points: { id: string; x: number; y: number }[],
  labels: { id: string; width: number; prefer: 'right' | 'left' }[],
  opts: { bounds: Rect; obstacles?: Rect[] },
): Record<string, LabelSpot> {
  const byId = new Map(points.map(p => [p.id, p]))
  const dotBoxes = points.map(p => ({ id: p.id, r: { x0: p.x - R - 1, x1: p.x + R + 1, y0: p.y - R - 1, y1: p.y + R + 1 } }))
  const placed: Rect[] = []
  const out: Record<string, LabelSpot> = {}
  for (const l of labels) {
    const p = byId.get(l.id)
    if (!p) continue
    const order: LabelSpot[] = l.prefer === 'right'
      ? ['right', 'left', 'above-right', 'below-right', 'above', 'below', 'above-left', 'below-left']
      : ['left', 'right', 'above-left', 'below-left', 'above', 'below', 'above-right', 'below-right']
    let best: LabelSpot = order[0]
    let bestCost = Infinity
    for (const spot of order) {
      const r = labelRect(spot, p.x, p.y, l.width)
      let cost = 0
      for (const d of dotBoxes) if (d.id !== l.id) cost += overlap(r, d.r)
      for (const q of placed) cost += overlap(r, q)
      for (const o of opts.obstacles ?? []) cost += overlap(r, o)
      // Outside the chart counts double: clipped text is worse than crowded.
      cost += 2 * (area(r) - overlap(r, opts.bounds))
      if (cost < bestCost) { bestCost = cost; best = spot }
      if (cost === 0) break
    }
    out[l.id] = best
    placed.push(labelRect(best, p.x, p.y, l.width))
  }
  return out
}
