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
  }
}

export const PALETTE: Record<Theme, DeepDivePalette> = {
  dark: {
    chart: { bg: '#0C0D10', text: '#969BA3', grid: '#171A21', border: '#282C32' },
    legend: { bg: 'rgba(14,16,20,.72)', text: '#E8EAED' },
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
    },
  },
  light: {
    chart: { bg: '#FFFFFF', text: '#444444', grid: '#F2F2F2', border: '#DDDDDD' },
    legend: { bg: 'rgba(255,255,255,.85)', text: '#222222' },
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
    },
  },
}
