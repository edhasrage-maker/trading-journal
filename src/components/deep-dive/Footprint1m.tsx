'use client'

/**
 * 1-minute delta footprint strip — port of the blind re-tag viewer's
 * renderFootprint(). Always 1-minute, whatever the chart timeframe (the
 * founder executes off the 1m footprint).
 *
 * Cells: delta per row, blue/red by sign, shaded by |delta| vs the bar's max.
 * Yellow box = bar POC. Side bars = 3+ stacked imbalances (green ask, red bid).
 * Orange row = entry; dashed red / green rows = stop / TP. Header: time, range,
 * VPS (bolder + bigger at 2x / 3x / 4x the prior-10 median); footer: closed
 * delta (bold when both a delta spike and a VPS spike).
 */
import { useEffect, useMemo, useRef } from 'react'
import type { Bar1m, VapRow } from '@/lib/orderflow/bars'
import { footprintModel } from '@/lib/orderflow/footprint'
import { fmtT } from './time-chart'
import type { DeepDivePalette } from './palette'

const RH = 15, CW = 80, AX = 68

export default function Footprint1m({
  m1, vap, entry, bracket, bars, g, ratio, minVol, palette: F,
}: {
  m1: Bar1m[]
  vap: VapRow[][]
  entry: { price: number; entrySec: number }
  bracket: { stop: number | null; tp: number | null }
  bars: number; g: number; ratio: number; minVol: number
  palette: DeepDivePalette['footprint']
}) {
  const model = useMemo(
    () => footprintModel(m1, vap, { bars, g, ratio, minVol }, entry, bracket),
    [m1, vap, bars, g, ratio, minVol, entry, bracket],
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)

  const { cols, eK, sK, tK, kmin, kmax } = model
  const N = cols.length
  const W = AX + N * CW, rows = (kmax - kmin) / g + 1, Hh = rows * RH

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = W * dpr; cv.height = Hh * dpr; cv.style.width = `${W}px`; cv.style.height = `${Hh}px`
    const ctx = cv.getContext('2d'); if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, Hh); ctx.textBaseline = 'middle'
    const y = (k: number) => (kmax - k) / g * RH
    for (let k = kmin; k <= kmax; k += g) {
      const yy = y(k)
      if (k === eK) { ctx.fillStyle = 'rgba(255,159,26,.22)'; ctx.fillRect(0, yy, W, RH) }
      ctx.font = '11px Consolas, monospace'; ctx.fillStyle = k === eK ? F.entry : k === sK ? F.stop : k === tK ? F.tp : F.priceLabel
      ctx.textAlign = 'right'; ctx.fillText((k / 4).toFixed(2), AX - 8, yy + RH / 2)
    }
    cols.forEach((c, j) => {
      const x0 = AX + j * CW, b = c.bar, get = (k: number) => c.cells.get(k) || [0, 0]
      ctx.fillStyle = b.partial ? F.partialFill : F.colFill; ctx.fillRect(x0 + 1, 0, CW - 2, Hh)
      ctx.font = '11px Consolas, monospace'; ctx.textAlign = 'center'
      for (let k = c.klo; k <= c.khi; k += g) {
        const [bb, aa] = get(k), d = aa - bb, yy = y(k), a = 0.06 + 0.45 * Math.abs(d) / c.maxAbsDelta
        ctx.fillStyle = d > 0 ? `rgba(0,150,255,${a})` : d < 0 ? `rgba(255,50,50,${a})` : 'rgba(255,255,255,.03)'
        ctx.fillRect(x0 + 9, yy + 1, CW - 18, RH - 2)
        ctx.fillStyle = d > 0 ? F.up : d < 0 ? F.down : F.zero
        ctx.fillText(String(d), x0 + CW / 2, yy + RH / 2)
      }
      for (const s of c.stacked) {
        ctx.fillStyle = s.side === 'ask' ? '#2fd47f' : '#ff5b5b'
        ctx.fillRect(s.side === 'ask' ? x0 + CW - 8 : x0 + 4, y(s.kTop), 4, s.cnt * RH)
      }
      if (c.poc != null) { ctx.strokeStyle = F.poc; ctx.lineWidth = 1.2; ctx.strokeRect(x0 + 9.5, y(c.poc) + 0.5, CW - 19, RH - 1) }
      const oK = Math.floor(Math.round(b.o * 4) / g) * g, cK = Math.floor(Math.round(b.c * 4) / g) * g
      ctx.fillStyle = F.rangeStrip; ctx.fillRect(x0 + 1, y(c.khi), 2, (c.khi - c.klo) / g * RH + RH)
      ctx.fillStyle = b.c >= b.o ? '#26a69a' : '#ef5350'
      const yt = y(Math.max(oK, cK)), yb = y(Math.min(oK, cK)) + RH; ctx.fillRect(x0 + 1, yt, 3, yb - yt)
    })
    ctx.strokeStyle = '#ff9f1a'; ctx.lineWidth = 1; ctx.strokeRect(0.5, y(eK) + 0.5, W - 1, RH - 1)
    if (sK != null && sK >= kmin && sK <= kmax) { ctx.strokeStyle = '#ef5350'; ctx.setLineDash([3, 3]); ctx.strokeRect(0.5, y(sK) + 0.5, W - 1, RH - 1); ctx.setLineDash([]) }
    if (tK != null && tK >= kmin && tK <= kmax) { ctx.strokeStyle = '#26a69a'; ctx.setLineDash([3, 3]); ctx.strokeRect(0.5, y(tK) + 0.5, W - 1, RH - 1); ctx.setLineDash([]) }
    const sc = scrollRef.current
    if (sc) sc.scrollTop = Math.max(0, y(eK) - sc.clientHeight / 2 + RH / 2)
  }, [cols, eK, sK, tK, kmin, kmax, g, W, Hh, F])

  const onScroll = () => {
    const sl = scrollRef.current?.scrollLeft ?? 0
    if (headRef.current) headRef.current.style.transform = `translateX(${-sl}px)`
    if (footRef.current) footRef.current.style.transform = `translateX(${-sl}px)`
  }

  return (
    <div className="flex flex-col h-full min-h-0 font-mono text-[11px]" style={{ color: 'var(--ts-mut)' }}>
      <div className="overflow-hidden flex-none">
        <div ref={headRef} className="flex whitespace-nowrap py-0.5 leading-[1.35]">
          <div style={{ width: AX }} className="text-center flex-none"><div>1m</div><div>range</div><div>VPS</div></div>
          {cols.map(c => {
            const s = c.stats
            const vcol = s.tier ? (s.up ? F.vpsUp : F.vpsDown) : 'var(--ts-mut)'
            return (
              <div key={c.i} style={{ width: CW }} className="text-center flex-none">
                <div style={{ color: c.bar.partial ? F.entry : undefined }}>{fmtT(c.bar.t)}{c.bar.partial ? ' →fill' : ''}</div>
                <div>{s.range.toFixed(2)}</div>
                <div style={{ color: vcol, fontWeight: [400, 600, 700, 800][s.tier], fontSize: 11 + s.tier * 2 }}>{s.vps.toFixed(2)}</div>
              </div>
            )
          })}
        </div>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto relative">
        <canvas ref={canvasRef} className="block" />
      </div>
      <div className="overflow-hidden flex-none">
        <div ref={footRef} className="flex whitespace-nowrap">
          <div style={{ width: AX }} className="text-center flex-none">Δ</div>
          {cols.map(c => {
            const s = c.stats, comb = s.dSpike && s.tier > 0
            const col = comb ? (s.d >= 0 ? F.vpsUp : F.vpsDown) : (s.d >= 0 ? F.deltaUp : F.deltaDown)
            return (
              <div key={c.i} style={{ width: CW }} className="text-center flex-none">
                <span style={{ color: col, fontWeight: comb ? 800 : 400, fontSize: comb ? 14 : 12 }}>{s.d}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
