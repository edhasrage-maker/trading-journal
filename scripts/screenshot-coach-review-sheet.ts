/**
 * Render the grader's output as one self-contained HTML page — screenshot,
 * the trader's claim, the tape truth, and the coach's read side by side — so
 * the trader can judge the coach's VOICE and CLAIMS before it goes anywhere
 * near the site.
 *
 *   npx tsx scripts/screenshot-coach-review-sheet.ts
 *   npx tsx scripts/screenshot-coach-review-sheet.ts --out=<path.html>
 *
 * Reads reads.jsonl + the trades JSONL beside it; embeds each screenshot as
 * a data URI (the signed URLs expire, and the sheet should outlive them).
 * Local file only — nothing is published.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const DIR = join(process.cwd(), 'evals', 'screenshot-coach')
const OUT = argVal('out') ?? join(DIR, 'review-sheet.html')

/* eslint-disable @typescript-eslint/no-explicit-any */
const grades = readFileSync(join(DIR, 'reads.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as any)
const tradesFile = ['labelled-trades.jsonl', 'unlabelled-trades.jsonl']
  .map(f => join(DIR, f)).find(p => { try { readFileSync(p); return true } catch { return false } })!
const trades = new Map(readFileSync(tradesFile, 'utf8').trim().split('\n').map(l => { const r = JSON.parse(l); return [r.trade_id, r] as [string, any] }))
/* eslint-enable @typescript-eslint/no-explicit-any */

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmt = (v: unknown) => v == null ? '—' : String(v)

async function dataUri(url: string, path: string): Promise<string> {
  const res = await fetch(url)
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
  const ext = path.toLowerCase().split('.').pop() ?? 'jpg'
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}`
}

async function main() {
  const cards: string[] = []
  for (const [i, g] of grades.entries()) {
    const r = trades.get(g.trade_id)
    if (!r) continue
    const img = await dataUri(r.frame.signed_url, r.frame.storage_path ?? '')
    const t = r.truth
    const claim = r.claim
    const tags = ['setups', 'confluences', 'order_flow', 'entry_model', 'trade_management']
      .flatMap(k => (claim[k] as string[]).map(v => `<span class="tag">${esc(v)}</span>`)).join(' ')
    const b = g.blind as Record<string, string> | undefined
    const ver = g.verification as Record<string, { status: string; truth: string | null }> | undefined
    const w = g.write as { verdict: 'good' | 'not_good' | 'mixed'; read: string; dropped: string[]; footprint_observation: string | null } | null
    const VLABEL: Record<string, string> = { good: 'good trade', not_good: 'not a good trade', mixed: 'mixed' }
    const VCLS: Record<string, string> = { confirmed: 'v-agree', contradicted: 'v-diverge', partial: 'v-partial', unverifiable: 'v-na', not_read: 'v-na' }
    const ELEM: Record<string, string> = { direction: 'direction', level_in_play: 'level in play', with_or_against: 'with / against 5m', timing: 'timing', footprint: 'footprint' }
    const PCLS: Record<string, string> = { confirmed: 'v-agree', contradicted: 'v-diverge', unverifiable: 'v-na' }
    const pr = (ver as unknown as { price_reads?: Array<{ kind: string; price: number; time: string | null; label: string | null; status: string; against: string; touches: number | null }> } | undefined)?.price_reads ?? []
    const priceRows = pr.map(p => `<tr class="${PCLS[p.status]}"><td>${esc(p.kind.replace('_', ' '))}${p.label ? ` “${esc(p.label)}”` : ''}${p.time ? ` @ ${esc(p.time)}` : ''}</td><td>${p.price}</td><td class="st">${esc(p.status)}</td><td class="tr">${esc(p.against)}${p.touches != null ? ` · ${p.touches} touches` : ''}</td></tr>`).join('')
    const verRows = b && ver ? Object.entries(ELEM).map(([k, label]) => {
      const v = ver[k]; const readVal = k === 'level_in_play' && b.level_side && b.level_side !== 'n/a' ? `${b[k]} (${b.level_side})` : b[k]
      return `<tr class="${VCLS[v.status]}"><td>${label}</td><td>${esc(readVal)}</td><td class="st">${v.status.replace('_', ' ')}</td><td class="tr">${esc(v.truth ?? '')}</td></tr>`
    }).join('') : ''
    const axes = w ? `
      <div class="blind"><span class="lbl">blind read</span> ${esc(b?.trade_type)} · ${esc(b?.note)}</div>
      <table class="ver"><tr><th></th><th>image said</th><th>bars</th><th>bar truth</th></tr>${verRows}</table>
      ${priceRows ? `<table class="ver prices"><tr><th>price read off image</th><th>price</th><th>check</th><th>against</th></tr>${priceRows}</table>` : ''}
      <div class="verdict v-${w.verdict}">${VLABEL[w.verdict]}</div>
      <div class="readtxt">${esc(w.read)}</div>
      ${w.dropped.length ? `<div class="dropped">image reads the bars threw out: ${esc(w.dropped.join(' · '))}</div>` : ''}
      ${w.footprint_observation ? `<div class="fp"><span class="lbl">footprint (unverified)</span> ${esc(w.footprint_observation)}</div>` : ''}` : `<div class="err">error: ${esc(g.error)}</div>`
    const near = t.location.nearest
    cards.push(`
    <section class="card">
      <header>
        <span class="n">${i + 1}</span>
        <span class="title">${esc(r.date)} · ${esc(r.entry_pt?.slice(11))} · ${esc(r.direction)} ${esc(r.symbol)}</span>
        <span class="pnl ${(t.exit.pnl ?? 0) >= 0 ? 'pos' : 'neg'}">${t.exit.pnl == null ? '' : (t.exit.pnl >= 0 ? '+' : '−') + '$' + Math.abs(Math.round(t.exit.pnl))}</span>
        <span class="meta">${esc(r.frame.capture_source)} · ${r.frame.proven_pre_exit ? 'pre-exit' : 'unknown timing'}</span>
      </header>
      <img src="${img}" alt="trade screenshot">
      <div class="cols">
        <div class="col">
          <h4>Your tags <span class="muted" style="text-transform:none;letter-spacing:0">(not shown to the coach)</span></h4>
          <div class="tags">${tags || '<i>no tags</i>'}</div>
          ${claim.read ? `<p class="read">“${esc(claim.read)}”</p>` : '<p class="read muted">no note</p>'}
          <h4>Tape</h4>
          <table>
            <tr><td>entry / exit</td><td>${fmt(t.entry_price)} → ${fmt(t.exit_price)}</td></tr>
            <tr><td>stop / TP1</td><td>${fmt(t.stop_price)} / ${fmt(t.tp1_price)}</td></tr>
            <tr><td>TP vs refs</td><td>${t.exit?.tp1_vs_reference ? `${t.exit.tp1_vs_reference.dist_pts} pts ${esc(t.exit.tp1_vs_reference.side)} ${esc(t.exit.tp1_vs_reference.level)}${t.exit.tp1_vs_reference.band ? ` · <b>${esc(t.exit.tp1_vs_reference.band)}</b>` : ''}${t.exit.tp1_missed_by_pts != null ? ` · missed by ${t.exit.tp1_missed_by_pts} pts` : ''}${t.exit.tp_terrain ? ` · lands in ${esc(t.exit.tp_terrain.destination)}${t.exit.tp_terrain.crosses_thin ? `, crosses ${t.exit.tp_terrain.widest_thin_gap_pts} pts thin` : ''}` : ''}` : '—'}</td></tr>
            <tr><td>stop terrain</td><td>${t.exit?.stop_terrain ? `${t.exit.stop_terrain.inside_entry_node ? '<b>inside entry node</b>' : 'beyond node edge'} · lands in ${esc(t.exit.stop_terrain.destination)}` : '—'}</td></tr>
            <tr><td>nearest level</td><td>${near ? `${near.name} ${near.price} · ${near.dist_pts} pts · ${near.dist_adr} ADR · ${near.side}` : '—'}</td></tr>
            <tr><td>5m structure</td><td>${fmt(t.structure.alignment_5m)}</td></tr>
            <tr><td>run before entry</td><td>${fmt(t.chase.run_before_entry_pts)} pts · ${fmt(t.chase.run_before_entry_atr)} ATR</td></tr>
            <tr><td>MFE / MAE</td><td>${fmt(t.exit.mfe_atr)} / ${fmt(t.exit.mae_atr)} ATR</td></tr>
            <tr><td>capture / R</td><td>${fmt(t.exit.capture_pct)}% / ${fmt(t.exit.r_multiple)}R</td></tr>
            <tr><td>post-exit 15m</td><td>+${fmt(t.exit.post_exit_favorable_atr)} / −${fmt(t.exit.post_exit_against_atr)} ATR</td></tr>
          </table>
          <h4 style="margin-top:10px">Context</h4>
          <table>
            <tr><td>session profile</td><td>${t.context?.session_profile_at_entry ? `${esc(t.context.session_profile_at_entry.zone)} · ${esc(t.context.session_profile_at_entry.node)} (${t.context.session_profile_at_entry.vol_at_price_vs_median}× median)` : '—'}</td></tr>
            <tr><td>prior-day profile</td><td>${t.context?.prior_day_profile ? `${esc(t.context.prior_day_profile.zone)} · POC ${t.context.prior_day_profile.poc} · VA ${t.context.prior_day_profile.val}–${t.context.prior_day_profile.vah}` : '—'}</td></tr>
            <tr><td>5m swings</td><td>${t.context?.swing_structure_5m ? `${esc(t.context.swing_structure_5m.label)} · trade is ${esc(t.context.swing_structure_5m.trade_is ?? '—')}` : '—'}</td></tr>
            <tr><td>momentum</td><td>${t.context?.session_momentum ? `${t.context.session_momentum.trade_is === 'offsides' ? '<b>OFFSIDES</b>' : t.context.session_momentum.trade_is === 'with' ? 'with' : '—'} · ${esc(t.context.session_momentum.label)}` : '—'}</td></tr>
            <tr><td>ATR vs typical · IB</td><td>${fmt(t.context?.atr_vs_typical)}× · ${fmt(t.context?.ib_regime)} / ${fmt(t.context?.ib_size_band)}</td></tr>
            <tr><td>attempts before</td><td>${t.context?.attempts_before ? `${t.context.attempts_before.count}${t.context.attempts_before.count ? ` in ${t.context.attempts_before.span_minutes} min, ${t.context.attempts_before.pnl_of_prior_attempts >= 0 ? '+' : ''}$${t.context.attempts_before.pnl_of_prior_attempts}` : ''}` : '—'}</td></tr>
            <tr><td>prior week H/L</td><td>${t.context?.prior_week ? `${t.context.prior_week.pwh} / ${t.context.prior_week.pwl}` : '—'}</td></tr>
            <tr><td>week value</td><td>${t.context?.htf_alignment ? `prior: ${esc(t.context.htf_alignment.prior_week_value ?? '—')} · developing: ${esc(t.context.htf_alignment.developing_week_value ?? '—')}` : '—'}</td></tr>
            <tr><td>runway</td><td>${t.context?.runway?.length ? t.context.runway.map((r: { level: string; dist_pts: number }) => `${esc(r.level)} ${r.dist_pts} pts`).join(' · ') : '—'}</td></tr>
          </table>
        </div>
        <div class="col coach">
          <h4>Coach — its own read, checked against the bars</h4>
          ${axes}
        </div>
      </div>
    </section>`)
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Screenshot coach — review sheet</title>
<style>
  :root{--bg:#0f1115;--card:#161a22;--line:#242a35;--fg:#e6e8ee;--mute:#8b93a7;--blue:#4c8dff;--green:#3ddc84;--red:#ff5d5d;--amber:#f5b342}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,Segoe UI,Inter,sans-serif;padding:24px}
  h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 20px;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:0 0 28px;overflow:hidden}
  header{display:flex;gap:14px;align-items:baseline;padding:10px 14px;border-bottom:1px solid var(--line)}
  .n{color:var(--blue);font-weight:700}.title{font-weight:600}.pnl.pos{color:var(--green)}.pnl.neg{color:var(--red)}
  .meta{margin-left:auto;color:var(--mute);font-size:12px}.bad{color:var(--red)}
  img{display:block;width:100%;max-height:70vh;object-fit:contain;background:#000}
  .cols{display:grid;grid-template-columns:1fr 1.3fr;gap:0}.col{padding:12px 14px}.col+.col{border-left:1px solid var(--line)}
  h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
  .tags{margin-bottom:6px}.tag{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:1px 6px;font-size:12px;margin:0 4px 4px 0}
  .read{margin:0 0 12px;font-style:italic}.muted{color:var(--mute)}
  table{border-collapse:collapse;font-size:12.5px;width:100%}td{padding:2px 8px 2px 0;vertical-align:top}td:first-child{color:var(--mute);white-space:nowrap}
  .axis{border-left:3px solid var(--line);padding:6px 10px;margin:0 0 8px;background:#12151c}
  .axis-head{display:flex;justify-content:space-between;font-size:12px}.axis-name{color:var(--mute)}
  .verdict{font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.05em}
  .v-agree{border-left-color:var(--green)}.v-agree .verdict{color:var(--green)}
  .v-diverge{border-left-color:var(--red)}.v-diverge .verdict{color:var(--red)}
  .v-na{border-left-color:var(--line)}.v-na .verdict{color:var(--mute)}.v-na .axis-sentence{color:var(--mute)}
  .axis-claim{color:var(--mute);font-size:12px;margin:2px 0}.axis-sentence{margin-top:2px}
  .suggested{border-left:3px solid var(--blue);padding:6px 10px;margin-top:10px;font-size:13px}
  .gated{color:var(--amber);font-weight:400;text-transform:none;letter-spacing:0;margin-left:8px}
  .err{color:var(--red)}
  .blind{font-size:12.5px;color:var(--mute);margin-bottom:8px}.lbl{text-transform:uppercase;font-size:10.5px;letter-spacing:.06em;color:var(--blue);margin-right:6px}
  table.ver{margin:0 0 10px;font-size:12px}table.ver th{text-align:left;color:var(--mute);font-weight:500;padding:0 8px 4px 0}
  table.ver td{padding:3px 8px 3px 6px;border-left:3px solid var(--line)}table.ver td:first-child{color:var(--mute)}
  table.ver tr.v-agree td:first-child{border-left-color:var(--green)}table.ver tr.v-diverge td:first-child{border-left-color:var(--red)}
  table.ver tr.v-partial td:first-child{border-left-color:var(--amber)}table.ver .st{font-weight:600}
  table.ver tr.v-agree .st{color:var(--green)}table.ver tr.v-diverge .st{color:var(--red)}table.ver tr.v-partial .st{color:var(--amber)}table.ver .tr{color:var(--mute)}
  .readtxt{font-size:14px;line-height:1.5;margin:0 0 8px;padding:8px 10px;background:#12151c;border-left:3px solid var(--blue)}
  .dropped{font-size:12px;color:var(--mute);margin-bottom:8px}.fp{font-size:12.5px;color:var(--mute)}
  .verdict{font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-size:12px;margin:8px 0 4px}.verdict.v-good{color:var(--green)}.verdict.v-not_good{color:var(--red)}.verdict.v-mixed{color:var(--amber)}
</style></head><body>
<h1>Screenshot coach — review sheet</h1>
<p class="sub">${cards.length} trades · the coach read each chart BLIND (no tags), then every element of that read was checked against the bars: green = bars confirm · red = bars contradict (dropped from the read) · amber = partly · grey = bars can't say. Prices the coach read off the image are each looked up in the bar record or the recorded fills; only confirmed ones may be spoken. Then the coach gives a verdict on the trade's PLACEMENT — value area, node, swing structure, volatility, attempts — not its P&L. Your tags are shown here for you; the coach never sees them. These ${cards.length} trades are now excluded from calibration scoring.</p>
${cards.join('\n')}
</body></html>`
  writeFileSync(OUT, html, 'utf8')
  console.log(`wrote ${OUT} (${(html.length / 1024 / 1024).toFixed(1)} MB)`)
}
main().catch(e => { console.error(e); process.exit(1) })
