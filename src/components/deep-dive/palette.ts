/**
 * Deep Dive colours per app theme. Every chart surface in the workspace reads
 * from here, so light and dark each look like one surface.
 *
 *  light — Sierra's own look: white charts, and the founder's Delta Heat Map
 *          colours exactly as the study defines them (they assume a light
 *          background).
 *  dark  — carbon charts. The study's colours don't survive a dark ground (its
 *          largest sell bubble is near-black red, its smallest buy bubble dark
 *          navy), so the bubbles keep their hue and level order but are
 *          re-toned: the bigger the bubble, the brighter it is.
 */
import type { Theme } from '@/components/ThemeToggle'

export interface DeepDivePalette {
  chart: { bg: string; text: string; grid: string; border: string }
  legend: { bg: string; text: string }
  /** Candle body + wick, up / down. */
  candleUp: string; candleDown: string
  /** Candle outlines (Sierra-style): off by default; when on they also draw the wicks. */
  candleOutline: boolean; outlineUp: string; outlineDown: string
  vwap: string; rvwap: string; ema9: string; ema20: string
  barPoc: string
  exitMarker: string
  /** Level / bracket price-line colour set. */
  levels: 'dark' | 'light'
  bubbles: {
    /** [level 0, 1, 2] per side. */
    buy: [string, string, string]
    sell: [string, string, string]
    ringBuy: string; ringSell: string
    labelBg: string; labelBuy: string; labelSell: string
    bars40: string
    caption: string
  }
  footprint: {
    priceLabel: string; entry: string; stop: string; tp: string
    up: string; down: string; zero: string
    colFill: string; partialFill: string; rangeStrip: string
    poc: string
    vpsUp: string; vpsDown: string; deltaUp: string; deltaDown: string
    /** Cell shading, buying / selling: the colour, faded by the row's share of the bar's biggest delta. */
    cellBuy: string; cellSell: string
    /** Side bars for 3+ stacked imbalances. */
    stackBuy: string; stackSell: string
    /** Row outlines across the strip, and the entry row's band. */
    entryLine: string; entryBand: string; stopLine: string; tpLine: string
    /** Each column's open-close strip, up / down bar. */
    barUp: string; barDown: string
    bg: string
  }
}

export const PALETTE: Record<Theme, DeepDivePalette> = {
  dark: {
    chart: { bg: '#0C0D10', text: '#969BA3', grid: '#171A21', border: '#282C32' },
    legend: { bg: 'rgba(14,16,20,.72)', text: '#E8EAED' },
    candleUp: '#26A69A', candleDown: '#EF5350',
    candleOutline: false, outlineUp: '#64B1FF', outlineDown: '#FF5A50',
    vwap: '#E8E8E8', rvwap: 'rgba(200,200,200,.45)', ema9: '#4FC3F7', ema20: '#BA68C8',
    barPoc: '#FFD23F',
    exitMarker: '#C3C7CF',
    levels: 'dark',
    bubbles: {
      buy: ['rgb(40,96,160)', 'rgb(30,136,229)', 'rgb(120,190,255)'],
      sell: ['rgb(150,56,50)', 'rgb(229,57,45)', 'rgb(255,125,105)'],
      ringBuy: 'rgb(100,177,255)', ringSell: 'rgb(255,90,80)',
      labelBg: '#1B1E23', labelBuy: 'rgb(140,200,255)', labelSell: 'rgb(255,120,110)',
      bars40: 'rgba(160,160,160,.35)',
      caption: '#5E636B',
    },
    footprint: {
      priceLabel: '#7D8591', entry: '#FF9F1A', stop: '#FF6B6B', tp: '#4EE08F',
      up: '#7CC4FF', down: '#FF8A8A', zero: '#5D6470',
      colFill: 'rgba(255,255,255,.015)', partialFill: 'rgba(255,159,26,.05)', rangeStrip: 'rgba(180,180,180,.35)',
      poc: '#FFD23F',
      vpsUp: '#4DA3FF', vpsDown: '#FF4D4D', deltaUp: '#3FA9FF', deltaDown: '#FF5A5A',
      cellBuy: '#0096FF', cellSell: '#FF3232', stackBuy: '#2FD47F', stackSell: '#FF5B5B',
      entryLine: '#FF9F1A', entryBand: 'rgba(255,159,26,.22)', stopLine: '#EF5350', tpLine: '#26A69A',
      barUp: '#26A69A', barDown: '#EF5350',
      bg: '#0C0D10',
    },
  },
  light: {
    chart: { bg: '#FFFFFF', text: '#444444', grid: '#F2F2F2', border: '#DDDDDD' },
    legend: { bg: 'rgba(255,255,255,.85)', text: '#222222' },
    candleUp: '#26A69A', candleDown: '#EF5350',
    candleOutline: false, outlineUp: '#64B1FF', outlineDown: '#A80000',
    vwap: '#333333', rvwap: 'rgba(60,60,60,.45)', ema9: '#0288D1', ema20: '#8E24AA',
    barPoc: '#C99700',
    exitMarker: '#555555',
    levels: 'light',
    bubbles: {
      buy: ['rgb(0,53,106)', 'rgb(0,89,179)', 'rgb(94,174,255)'],
      sell: ['rgb(243,80,71)', 'rgb(238,27,15)', 'rgb(96,11,6)'],
      ringBuy: 'rgb(100,177,255)', ringSell: 'rgb(168,0,0)',
      labelBg: '#FFFFFF', labelBuy: 'rgb(0,64,128)', labelSell: 'rgb(255,0,0)',
      bars40: 'rgba(120,120,120,.4)',
      caption: '#888888',
    },
    footprint: {
      priceLabel: '#6B7280', entry: '#E07B00', stop: '#D32F2F', tp: '#2E7D32',
      up: '#0B5FA5', down: '#C62828', zero: '#9AA0A6',
      colFill: 'rgba(0,0,0,.02)', partialFill: 'rgba(255,159,26,.08)', rangeStrip: 'rgba(0,0,0,.2)',
      poc: '#C99700',
      vpsUp: '#1565C0', vpsDown: '#D32F2F', deltaUp: '#1976D2', deltaDown: '#E53935',
      cellBuy: '#0096FF', cellSell: '#FF3232', stackBuy: '#2FD47F', stackSell: '#FF5B5B',
      entryLine: '#FF9F1A', entryBand: 'rgba(255,159,26,.22)', stopLine: '#EF5350', tpLine: '#26A69A',
      barUp: '#26A69A', barDown: '#EF5350',
      bg: '#FFFFFF',
    },
  },
}

/**
 * The footprint colours a trader can change (Chart Settings → Footprint
 * colours). Nine picks; the rest follows from them: Buying / Selling also set
 * the cell numbers, the delta row and the VPS highlight, a shade darker on a
 * light chart and lighter on a dark one. Nothing changes until a colour is
 * picked — the built-in theme stays exactly as it was.
 *
 * Plus the candle pair (Chart Settings → Candles): Up / Down candles colour
 * both the candle chart and each footprint column's open-close strip; and
 * Candle outlines (off by default) put a Sierra-style outline on each candle
 * of the candle chart, drawing the wicks in the outline colour too.
 */
export const FP_COLOR_KEYS = ['buy', 'sell', 'sbuy', 'ssell', 'poc', 'entry', 'stop', 'tp', 'bg'] as const
export const CANDLE_COLOR_KEYS = ['cup', 'cdown'] as const
export const OUTLINE_COLOR_KEYS = ['oup', 'odown'] as const
export type FpColorKey = (typeof FP_COLOR_KEYS)[number] | (typeof CANDLE_COLOR_KEYS)[number] | (typeof OUTLINE_COLOR_KEYS)[number]
/** The picks for one theme, plus the outline switch. */
export type FpColors = Partial<Record<FpColorKey, string>> & { outline?: boolean }
export const FP_COLOR_LABELS: Record<FpColorKey, string> = {
  buy: 'Buying', sell: 'Selling', sbuy: 'Stacked buying', ssell: 'Stacked selling',
  poc: 'Bar POC', entry: 'Entry', stop: 'Stop', tp: 'Target', bg: 'Background',
  cup: 'Up candles', cdown: 'Down candles', oup: 'Up outline', odown: 'Down outline',
}

/** What each picker shows before anything is changed: the theme's own colours. */
export function fpDefaults(theme: Theme): Record<FpColorKey, string> {
  const P = PALETTE[theme], F = P.footprint
  return {
    buy: F.cellBuy, sell: F.cellSell, sbuy: F.stackBuy, ssell: F.stackSell,
    poc: F.poc, entry: F.entryLine, stop: F.stopLine, tp: F.tpLine, bg: F.bg,
    cup: P.candleUp, cdown: P.candleDown, oup: P.outlineUp, odown: P.outlineDown,
  }
}

/** The whole palette with the trader's candle picks laid over the theme's. */
export function withCandleColors(base: DeepDivePalette, o: FpColors): DeepDivePalette {
  if (!o.cup && !o.cdown && !o.outline) return base
  return {
    ...base,
    candleUp: o.cup ?? base.candleUp, candleDown: o.cdown ?? base.candleDown,
    candleOutline: !!o.outline, outlineUp: o.oup ?? base.outlineUp, outlineDown: o.odown ?? base.outlineDown,
  }
}

const rgbOf = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16) || 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const alpha = (hex: string, a: number) => `rgba(${rgbOf(hex).join(',')},${a})`
/** Text colour from a picked colour: darker on a light chart, lighter on a dark one. */
const ink = (hex: string, theme: Theme) =>
  `rgb(${rgbOf(hex).map(c => Math.round(theme === 'light' ? c * 0.7 : c + (255 - c) * 0.35)).join(',')})`

/** The footprint palette with the trader's picks laid over the theme's. */
export function withFpColors(base: DeepDivePalette['footprint'], o: FpColors, theme: Theme): DeepDivePalette['footprint'] {
  const F = { ...base }
  if (o.buy) { F.cellBuy = o.buy; F.up = F.vpsUp = F.deltaUp = ink(o.buy, theme) }
  if (o.sell) { F.cellSell = o.sell; F.down = F.vpsDown = F.deltaDown = ink(o.sell, theme) }
  if (o.sbuy) F.stackBuy = o.sbuy
  if (o.ssell) F.stackSell = o.ssell
  if (o.poc) F.poc = o.poc
  if (o.entry) {
    F.entryLine = o.entry; F.entryBand = alpha(o.entry, 0.22)
    F.partialFill = alpha(o.entry, theme === 'light' ? 0.08 : 0.05); F.entry = ink(o.entry, theme)
  }
  if (o.stop) { F.stopLine = o.stop; F.stop = ink(o.stop, theme) }
  if (o.tp) { F.tpLine = o.tp; F.tp = ink(o.tp, theme) }
  if (o.bg) F.bg = o.bg
  if (o.cup) F.barUp = o.cup
  if (o.cdown) F.barDown = o.cdown
  return F
}

/** Cell shading for one row: the picked colour, faded by size. */
export const fpShade = (hex: string, a: number) => alpha(hex, a)
