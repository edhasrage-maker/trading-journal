/**
 * Golden expectations for the CLIENT-side half of the reference: the blind
 * re-tag viewer (viewer.html, outside this repo) computes the footprint stats,
 * footprint grid, volume profiles, timeframe aggregation, Heiken-Ashi, bar POC
 * and ATR in the browser. Rather than re-type that code, this runs the viewer's
 * own <script> — read from disk, unmodified on disk — inside a Node vm with a
 * stub DOM, feeds it each reference payload, and records what it computes.
 *
 *   node scripts/orderflow-fixtures/gen_viewer_expected.mjs <fixture_dir> [viewer.html]
 *
 * For every <fixture_dir>/row-<seq>.json.gz it writes row-<seq>.viewer.json.gz.
 *
 * The footprint math lives inside renderFootprint()'s closure, so a COPY of that
 * function's source is instrumented in memory with capture statements at four
 * anchors. Each anchor must match exactly once or the run aborts — a viewer edit
 * can't silently desync the capture.
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { gunzipSync, gzipSync } from 'zlib'
import { join } from 'path'
import vm from 'vm'

const FIX = process.argv[2]
const VIEWER = (FIX === '--synthetic' ? process.argv[4] : process.argv[3])
  ?? 'D:/Documents/NQ_backtest/delta_bars/entries_2026-09-30/retag_work/viewer.html'
if (!FIX) {
  console.error('usage: gen_viewer_expected.mjs <fixture_dir> [viewer.html]\n       gen_viewer_expected.mjs --synthetic <synthetic.json> [viewer.html]')
  process.exit(2)
}

const html = readFileSync(VIEWER, 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
if (scripts.length !== 1) throw new Error(`expected 1 inline <script>, found ${scripts.length}`)
const SRC = scripts[0]

// ---- stub DOM ---------------------------------------------------------------
const noop = () => {}
function makeCtx2d() {
  const store = {}
  return new Proxy(store, {
    get: (t, p) => (p in t ? t[p] : p === 'measureText' ? () => ({ width: 10 }) : noop),
    set: (t, p, v) => { t[p] = v; return true },
  })
}
const NUMERIC = new Set(['clientHeight', 'clientWidth', 'scrollLeft', 'scrollTop', 'width', 'height', 'offsetWidth', 'offsetHeight'])
function makeEl() {
  const store = { style: {}, dataset: {} }
  return new Proxy(store, {
    get: (t, p) => {
      if (p in t) return t[p]
      if (NUMERIC.has(p)) return 0
      if (p === 'value' || p === 'textContent' || p === 'innerHTML') return ''
      if (p === 'classList') return { toggle: noop, add: noop, remove: noop, contains: () => false }
      if (p === 'getContext') return () => makeCtx2d()
      return noop
    },
    set: (t, p, v) => { t[p] = v; return true },
  })
}
function makeContext() {
  const els = new Map()
  const document = {
    querySelector: s => { if (!els.has(s)) els.set(s, makeEl()); return els.get(s) },
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: noop,
  }
  const ctx = {
    document,
    LightweightCharts: new Proxy({}, { get: () => noop }),
    localStorage: { getItem: () => null, setItem: noop },
    location: { search: '' },
    fetch: () => new Promise(noop),          // load() parks forever; we drive the functions directly
    requestAnimationFrame: noop,
    devicePixelRatio: 1,
    addEventListener: noop,
    console,
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(SRC, ctx, { filename: 'viewer.html<script>' })
  return ctx
}

// ---- instrumented copy of renderFootprint ------------------------------------
function patchOnce(src, anchor, replacement) {
  const n = src.split(anchor).length - 1
  if (n !== 1) throw new Error(`anchor matched ${n}x (want 1): ${anchor}`)
  return src.replace(anchor, replacement)
}
function instrumentedFootprint(ctx) {
  let f = vm.runInContext('renderFootprint.toString()', ctx)
  f = patchOnce(f, 'const eK=Math.floor(Math.round(D.row.price*4)/g)*g;',
    '__cap.cols=cols.map(c=>({t:c.b.t,partial:!!c.b.partial,s:c.s,klo:c.klo,khi:c.khi,m:[...c.m.entries()].sort((a,b)=>a[0]-b[0])}));' +
    'const eK=Math.floor(Math.round(D.row.price*4)/g)*g;')
  f = patchOnce(f, 'const RH=15, CW=80',
    '__cap.keys={eK,sK,tK,kmin,kmax,g,ratio,minV,N,first};const RH=15, CW=80')
  f = patchOnce(f, 'if(cnt>=3){ ctx.fillStyle=color;',
    'if(cnt>=3){ __cap.runs.push({j,color,kTop:k-g,cnt}); ctx.fillStyle=color;')
  f = patchOnce(f, "if(pk!=null){ ctx.strokeStyle='#ffd23f';",
    "__cap.grid.push({j,pk,mxd,askI:[...askI].sort((a,b)=>a-b),bidI:[...bidI].sort((a,b)=>a-b)});" +
    "if(pk!=null){ ctx.strokeStyle='#ffd23f';")
  vm.runInContext(`var __cap; var __renderFootprintCap = ${f};`, ctx)
}

// ---- per payload -------------------------------------------------------------
const AGG_KEYS = ['t', 'o', 'h', 'l', 'c', 'v', 'bv', 'av', 'd', 'dmin', 'dmax', 'ho', 'hc', 'hh', 'hl', 'poc', 'mark', 'partial']
const FP_CONFIGS = {
  NQ: [{ fp: 4, prof: 4, min: 5, fpR: 3 }, { fp: 1, prof: 1, min: 1, fpR: 2 }, { fp: 8, prof: 8, min: 10, fpR: 4 }],
  ES: [{ fp: 1, prof: 1, min: 20, fpR: 3 }, { fp: 2, prof: 2, min: 5, fpR: 2.5 }],
}

function expectedFor(payload) {
  const ctx = makeContext()
  instrumentedFootprint(ctx)
  ctx.__payload = payload
  const run = code => vm.runInContext(code, ctx)
  run(`D = JSON.parse(JSON.stringify(__payload)); st.g = {}; instDefaults(D.row.inst); prep();`)
  const out = {}
  out.atr = run(`({ atr1: D.atr1, atr5: D.atr5 })`)
  // last-bar VWAP / EMA as the viewer computes them (kept for the phase-2 comparison; not ported)
  out.viewer_last = run(`(() => { const b = M1[M1.length-1]; return { vwap: b.vwap, rvwap: b.rvwap, ema9: b.ema9, ema20: b.ema20 } })()`)
  out.agg = {}
  for (const tf of [1, 2, 3, 5, 15]) {
    out.agg[tf] = run(`st.tf = ${tf}; buildAgg(); AGG.map(b => ({ ${AGG_KEYS.map(k => `${k}: b.${k}`).join(', ')} }))`)
  }
  out.profile = {}
  for (const which of ['session', 'on', 'prior']) {
    for (const g of [1, 2, 4, 8, 16]) out.profile[`${which}:${g}`] = run(`profileFor('${which}', ${g})`)
  }
  out.footprint = []
  for (const cfg of FP_CONFIGS[payload.row.inst]) {
    run(`st.fp = true; st.fpN = 15; st.fpR = ${cfg.fpR}; st.g[D.row.inst] = { fp: ${cfg.fp}, prof: ${cfg.prof}, min: ${cfg.min} };
         __cap = { runs: [], grid: [] }; __renderFootprintCap();`)
    out.footprint.push({ cfg, ...JSON.parse(run('JSON.stringify(__cap)')) })
  }
  return JSON.parse(JSON.stringify(out))   // plain JSON (drops undefined, normalises -0)
}

if (FIX === '--synthetic') {
  // Synthetic mode: add the viewer expectations for the synthetic payload in place.
  const file = process.argv[3]
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.viewer = expectedFor(doc.payload)
  writeFileSync(file, JSON.stringify(doc))
  console.log(`${file}: viewer expectations added (${JSON.stringify(doc).length >> 10} KB)`)
  process.exit(0)
}

const files = readdirSync(FIX).filter(f => /^row-\d+\.json\.gz$/.test(f)).sort()
for (const f of files) {
  const doc = JSON.parse(gunzipSync(readFileSync(join(FIX, f))).toString())
  const exp = expectedFor(doc.payload)
  const outName = f.replace('.json.gz', '.viewer.json.gz')
  const raw = Buffer.from(JSON.stringify(exp))
  writeFileSync(join(FIX, outName), gzipSync(raw, { level: 9 }))
  console.log(`${outName}: agg1=${exp.agg[1].length} fp cfgs=${exp.footprint.length} cols=${exp.footprint[0].cols.length} runs=${exp.footprint[0].runs.length} atr1=${exp.atr.atr1?.toFixed(4)} raw=${raw.length >> 10}KB`)
}
