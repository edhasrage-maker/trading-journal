/**
 * Static levels as of the fill — port of the reference server's build_row()
 * level block. Every input is data from before the fill second; anything
 * still forming at the fill (overnight range before 06:30, IB before 07:30) is
 * flagged `dev`, and IB extensions only exist once the IB has closed.
 */
import type { MinuteBars, VapByMinute } from './minute-bars'
import { valueAreaTicks } from './profile'
import { pyRound } from './pymath'
import { tradingDate } from './pt-clock'

export type LevelGroup = 'pd' | 'on' | 'open' | 'ib' | 'ibx' | 'wk' | 'pw' | 'pva'

export interface Level {
  name: string
  price: number
  group: LevelGroup
  /** Still developing at the fill. */
  dev: boolean
}

export interface LevelInputs {
  /** Window bars, prior RTH open → fill (the last one partial if hasPartial). */
  bars: MinuteBars
  vap: VapByMinute
  /** PT-clock ms. */
  entry: number
  rthOpen: number
  rthClose: number
  ibEnd: number
  priorOpen: number
  priorClose: number
  /** Trading date of the fill. */
  tdate: string
  /** Open of the week's first bar (Sunday 15:00 PT anchor), resolved by the caller. */
  weekOpen: number | null
  /** High / low of the prior week (anchor - 7d → anchor). */
  priorWeek: { high: number | null; low: number | null }
}

export function levelsAsOf(x: LevelInputs): Level[] {
  const B = x.bars
  const n = B.t.length
  const tMs = (i: number) => B.t[i] * 1000
  const lv: Level[] = []
  const add = (name: string, px: number | null, group: LevelGroup, dev = false) => {
    if (px != null && Number.isFinite(px)) lv.push({ name, price: pyRound(px, 2), group, dev })
  }
  const hl = (pred: (i: number) => boolean): [number | null, number | null] => {
    let h = -Infinity, l = Infinity, any = false
    for (let i = 0; i < n; i++) if (pred(i)) { any = true; if (B.h[i] > h) h = B.h[i]; if (B.l[i] < l) l = B.l[i] }
    return any ? [h, l] : [null, null]
  }

  const [pdh, pdl] = hl(i => tMs(i) >= x.priorOpen && tMs(i) < x.priorClose)
  add('PDH', pdh, 'pd'); add('PDL', pdl, 'pd')

  const [onh, onl] = hl(i => tradingDate(tMs(i)) === x.tdate && tMs(i) < x.rthOpen)
  const onDev = x.entry < x.rthOpen
  add('ONH', onh, 'on', onDev); add('ONL', onl, 'on', onDev)

  if (x.entry >= x.rthOpen) {
    for (let i = 0; i < n; i++) if (tMs(i) >= x.rthOpen) { add('RTH Open', B.o[i], 'open'); break }
    const [ibh, ibl] = hl(i => tMs(i) >= x.rthOpen && tMs(i) < x.ibEnd)
    const ibDev = x.entry < x.ibEnd
    add('IBH', ibh, 'ib', ibDev); add('IBL', ibl, 'ib', ibDev)
    if (!ibDev && ibh != null && ibl != null) {
      const rng = ibh - ibl
      for (const p of [25, 50, 100]) {
        add(`IBH +${p}%`, ibh + rng * p / 100, 'ibx'); add(`IBL -${p}%`, ibl - rng * p / 100, 'ibx')
      }
    }
  }

  add('WK-OP', x.weekOpen, 'wk')
  add('PWH', x.priorWeek.high, 'pw'); add('PWL', x.priorWeek.low, 'pw')

  const tk: number[] = [], vol: number[] = []
  for (let k = 0; k < x.vap.m.length; k++) {
    const t = tMs(x.vap.m[k])
    if (t >= x.priorOpen && t < x.priorClose) { tk.push(x.vap.t[k]); vol.push(x.vap.b[k] + x.vap.a[k]) }
  }
  const va = valueAreaTicks(tk, vol)
  if (va) { add('pVAH', va.vah, 'pva'); add('pVAL', va.val, 'pva'); add('pPOC', va.poc, 'pva') }
  return lv
}

/** Weekly anchor (Sunday 15:00 PT at or before the entry), PT-clock ms. */
export function weeklyAnchor(entryPtMs: number): number {
  const DAY = 86_400_000
  const dsun = new Date(entryPtMs).getUTCDay()            // Sun=0 … Sat=6 == (py weekday + 1) % 7
  let anchor = Math.floor(entryPtMs / DAY) * DAY - dsun * DAY + 15 * 3_600_000
  if (anchor > entryPtMs) anchor -= 7 * DAY
  return anchor
}
