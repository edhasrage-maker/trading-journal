/**
 * Unit tests for src/lib/scatter-labels.ts (TapeScore vs Profit name labels).
 *   npx tsx scripts/test-scatter-labels.ts
 */
import { placeLabels, labelRect, type Rect } from '../src/lib/scatter-labels.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// The founder's 11/06 screenshot: plot ~650×206 px, x 40–100, y -$500…$1,500.
const W = 650, H = 206
const px = (score: number) => ((score - 40) / 60) * W
const py = (pnl: number) => (1 - (pnl + 500) / 2000) * H
const day = (id: string, score: number, pnl: number) => ({ id, x: px(score), y: py(pnl) })
const dots = [
  day('oct22', 49, 1297), day('nov4', 61, 1437), day('oct27', 69, 852),
  day('a', 49, 780), day('b', 49, 290), day('c', 67, 570), day('d', 63, 170),
  day('e', 65, 350), day('f', 68, 270), day('g', 69, 300), day('h', 69, 240),
  day('l1', 49, -150), day('oct29', 49, -413), day('l3', 53, -350), day('l4', 65, -280),
  day('s1', 79, 430), day('s2', 81, 170), day('s3', 83, 200), day('s4', 84, 210),
  day('s5', 85, 300), day('s6', 85, 680), day('s7', 91, 200), day('s8', 91, 80),
]
const bounds: Rect = { x0: -50, y0: -4, x1: W + 6, y1: H + 4 }
const spots = placeLabels(dots, [
  { id: 'nov4', width: 92, prefer: 'right' },
  { id: 'oct29', width: 86, prefer: 'right' },
  { id: 'oct22', width: 92, prefer: 'right' },
  { id: 'oct27', width: 86, prefer: 'right' },
], { bounds })

const covers = (id: string, width: number) => {
  const p = dots.find(d => d.id === id)!
  const r = labelRect(spots[id], p.x, p.y, width)
  return dots.filter(d => d.id !== id && d.x + 7 > r.x0 && d.x - 7 < r.x1 && d.y + 7 > r.y0 && d.y - 7 < r.y1).map(d => d.id)
}

console.log('Oct 29 (the label that was hidden)')
check('Oct 29 no longer sits on the losing dot beside it', !covers('oct29', 86).includes('l3'),
  `spot ${spots.oct29}, covers ${covers('oct29', 86).join(',')}`)
check('Oct 29 covers no dot at all', covers('oct29', 86).length === 0, `spot ${spots.oct29}`)

console.log('labels with room keep the plain look')
check('Nov 4 stays to the right', spots.nov4 === 'right', spots.nov4)
check('Oct 22 stays to the right', spots.oct22 === 'right', spots.oct22)
check('every label covers no dot', ['nov4', 'oct22', 'oct27'].every(id => covers(id, 92).length === 0),
  JSON.stringify(spots))

console.log('labels never overlap each other')
{
  const pts = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 104, y: 100 }]
  const s = placeLabels(pts, [{ id: 'a', width: 80, prefer: 'right' }, { id: 'b', width: 80, prefer: 'right' }],
    { bounds: { x0: 0, y0: 0, x1: 400, y1: 200 } })
  const ra = labelRect(s.a, 100, 100, 80), rb = labelRect(s.b, 104, 100, 80)
  const ov = Math.max(0, Math.min(ra.x1, rb.x1) - Math.max(ra.x0, rb.x0)) * Math.max(0, Math.min(ra.y1, rb.y1) - Math.max(ra.y0, rb.y0))
  check('two near-identical dots get separate spots', ov === 0, JSON.stringify(s))
}

console.log('the edge')
{
  const s = placeLabels([{ id: 'r', x: 395, y: 100 }], [{ id: 'r', width: 80, prefer: 'left' }],
    { bounds: { x0: 0, y0: 0, x1: 400, y1: 200 } })
  check('a dot at the right edge reads left', s.r === 'left', s.r)
}

console.log(failures === 0 ? '\nAll scatter-labels tests passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
