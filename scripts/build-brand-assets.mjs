/**
 * Regenerate the TapeScore brand assets — the "film-frame" mark (gold film gate
 * + three bone-white candles) with the wordmark set in the app's own display
 * font, Archivo: "Tape" Light + "Score" Bold.
 *
 *   node scripts/build-brand-assets.mjs           # writes public/brand + public/icons
 *   BRAND_OUT=/tmp/x node scripts/build-brand-assets.mjs   # preview elsewhere
 *
 * The wordmark is OUTLINED to vector paths (via opentype.js) rather than left as
 * live <text>: the logos are consumed as <img src=".svg">, and web-fonts do NOT
 * load inside an <img>-mode SVG, so live text would fall back to Arial. Outlining
 * makes the brand font render identically everywhere. Fonts are the static
 * Archivo Light/Bold TTFs vendored under scripts/brand-fonts (see README there).
 *
 * PNG icons (PWA + apple-touch) are rasterized from the mark with sharp.
 */
import opentype from 'opentype.js'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FONT_DIR = process.env.BRAND_FONT_DIR || resolve(HERE, 'brand-fonts')
const BRAND_OUT = process.env.BRAND_OUT || resolve(ROOT, 'public/brand')
const ICON_OUT = process.env.ICON_OUT || resolve(ROOT, 'public/icons')
// The browser-tab favicon. Next.js auto-serves src/app/favicon.ico at
// /favicon.ico (the path browsers request + cache hard), so it MUST be
// regenerated with the brand set — otherwise the tab keeps the old icon.
const FAVICON_OUT = process.env.FAVICON_OUT || resolve(ROOT, 'src/app/favicon.ico')
// Social link-preview cards. Next.js auto-serves src/app/opengraph-image.png +
// twitter-image.png and injects the og:image / twitter:image meta tags.
const APP_OUT = process.env.APP_OUT || resolve(ROOT, 'src/app')

const loadFont = (p) => {
  const b = readFileSync(p)
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
const light = loadFont(`${FONT_DIR}/Archivo-Light.ttf`)
const bold = loadFont(`${FONT_DIR}/Archivo-Bold.ttf`)

/** Outline `text` in `font` to SVG path data, advancing the pen by each glyph's
 *  advance + kerning + letterSpacing. Returns { d, x } (x = pen after the run). */
/** Round a coordinate to `dp` decimals as a string. Throws on non-finite so a
 *  bad glyph never silently ships a "NaN" token. */
function num(n, dp = 2) {
  const v = Math.round(n * 10 ** dp) / 10 ** dp
  if (!Number.isFinite(v)) throw new Error(`non-finite path coord: ${n}`)
  return String(v)
}

/** Serialize an opentype Path's COMMANDS directly. opentype v2's own
 *  toPathData() has a rounding bug that emits a literal "NaN" x-coordinate for
 *  certain glyphs at certain fractional pen positions (e.g. Archivo Bold 'S'
 *  after letter-spacing), which halts every SVG renderer at that point. The raw
 *  commands are always finite, so we round + serialize them ourselves. */
function pathData(path) {
  let d = ''
  for (const c of path.commands) {
    if (c.type === 'M') d += `M${num(c.x)} ${num(c.y)}`
    else if (c.type === 'L') d += `L${num(c.x)} ${num(c.y)}`
    else if (c.type === 'Q') d += `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`
    else if (c.type === 'C') d += `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`
    else if (c.type === 'Z') d += 'Z'
  }
  return d
}

function outline(font, text, size, x, baseY, ls) {
  const scale = size / font.unitsPerEm
  const chars = [...text]
  let d = ''
  // charToGlyph per character — avoids opentype v2's stringToGlyphs GSUB
  // shaping (unsupported in Archivo's ccmp table). A Latin wordmark needs no
  // ligature/context shaping; simple advance + pairwise kerning is exact.
  for (let i = 0; i < chars.length; i++) {
    const g = font.charToGlyph(chars[i])
    d += pathData(g.getPath(x, baseY, size))
    let adv = g.advanceWidth * scale
    const next = chars[i + 1] != null ? font.charToGlyph(chars[i + 1]) : null
    if (next) adv += (font.getKerningValue(g, next) || 0) * scale
    x += adv + ls
  }
  return { d, x }
}

/** "Tape" (Light) + "Score" (Bold) outlined along one continuous pen, returned
 *  as TWO separate <path> bodies. They MUST stay separate elements: concatenating
 *  a Light run and a Bold run into a single `d` makes librsvg (the PNG rasterizer
 *  + some SVG engines) drop the second run at the font-boundary. Two paths render
 *  identically everywhere. `fill` on the caller. */
function wordmark(size, startX, baseY, ls, fill) {
  const a = outline(light, 'Tape', size, startX, baseY, ls)
  const b = outline(bold, 'Score', size, a.x, baseY, ls)
  return {
    svg: `<path d="${a.d}" fill="${fill}"/><path d="${b.d}" fill="${fill}"/>`,
    endX: b.x - ls,
  }
}

const holes = (x, ys) => `<g fill="var(--hole)">` + ys.map(y => `<rect x="${x}" y="${y}" width="5" height="6" rx="1.2"/>`).join('') + '</g>'
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" role="img" aria-label="TapeScore">${body}</svg>\n`

// ── DARK horizontal lockup (primary, on dark UI) ─────────────────────────────
function darkLogo() {
  const YS = [5, 16, 27, 38, 49, 60]
  const frame = `<g transform="translate(6,14)">`
    + `<rect x="0" y="0" width="11" height="72" rx="2" fill="#E3A62F"/>` + holes(3, YS).replace(/var\(--hole\)/, '#111419')
    + `<rect x="57" y="0" width="11" height="72" rx="2" fill="#E3A62F"/>` + holes(60, YS).replace(/var\(--hole\)/, '#111419')
    + `<rect x="11" y="0" width="46" height="3" fill="#E3A62F"/><rect x="11" y="69" width="46" height="3" fill="#E3A62F"/>`
    + `<line x1="21" y1="44" x2="21" y2="62" stroke="#F3F5F7" stroke-width="2"/><rect x="17.5" y="48" width="7" height="11" rx="1" fill="#F3F5F7"/>`
    + `<line x1="34" y1="29" x2="34" y2="51" stroke="#F3F5F7" stroke-width="2"/><rect x="30.5" y="33" width="7" height="14" rx="1" fill="#F3F5F7"/>`
    + `<line x1="47" y1="13" x2="47" y2="38" stroke="#F3F5F7" stroke-width="2"/><rect x="43.5" y="16" width="7" height="18" rx="1" fill="#F3F5F7"/>`
    + `</g>`
  const wm = wordmark(42, 94, 58, -1.1, '#F3F5F7')
  const sub = `<text x="96" y="78" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="9" letter-spacing="3.4" fill="#7C8794">GAME FILM FOR TRADERS</text>`
  const subW = 96 + 'GAME FILM FOR TRADERS'.length * (9 * 0.62 + 3.4)
  const W = Math.ceil(Math.max(wm.endX, subW)) + 8
  return svg(W, 100, frame + wm.svg + sub)
}

// ── LIGHT / inverse horizontal lockup (on light surfaces) ────────────────────
function lightLogo() {
  const YS = [4, 15, 26, 37, 48]
  const frame = `<g transform="translate(4,8)">`
    + `<rect x="0" y="0" width="10" height="64" rx="2" fill="#C08A1C"/>` + holes(2.5, YS).replace(/var\(--hole\)/, '#F1F3F6')
    + `<rect x="52" y="0" width="10" height="64" rx="2" fill="#C08A1C"/>` + holes(54.5, YS).replace(/var\(--hole\)/, '#F1F3F6')
    + `<rect x="10" y="0" width="42" height="3" fill="#C08A1C"/><rect x="10" y="61" width="42" height="3" fill="#C08A1C"/>`
    + `<line x1="19" y1="39" x2="19" y2="55" stroke="#0A0C0F" stroke-width="2"/><rect x="15.8" y="42" width="6.4" height="10" rx="1" fill="#0A0C0F"/>`
    + `<line x1="31" y1="26" x2="31" y2="46" stroke="#0A0C0F" stroke-width="2"/><rect x="27.8" y="29" width="6.4" height="13" rx="1" fill="#0A0C0F"/>`
    + `<line x1="43" y1="12" x2="43" y2="34" stroke="#0A0C0F" stroke-width="2"/><rect x="39.8" y="15" width="6.4" height="16" rx="1" fill="#0A0C0F"/>`
    + `</g>`
  const wm = wordmark(36, 80, 52, -1, '#0A0C0F')
  return svg(Math.ceil(wm.endX) + 6, 82, frame + wm.svg)
}

// ── Icon / mark (no wordmark) — dark + light + full-bleed maskable ───────────
function iconBody(gold, hole, candle) {
  return `<rect x="22" y="24" width="17" height="80" rx="3" fill="${gold}"/>`
    + `<g fill="${hole}">${[30, 44, 58, 72, 86].map(y => `<rect x="27" y="${y}" width="7" height="8" rx="1.6"/>`).join('')}</g>`
    + `<rect x="89" y="24" width="17" height="80" rx="3" fill="${gold}"/>`
    + `<g fill="${hole}">${[30, 44, 58, 72, 86].map(y => `<rect x="94" y="${y}" width="7" height="8" rx="1.6"/>`).join('')}</g>`
    + `<rect x="39" y="24" width="50" height="5" fill="${gold}"/><rect x="39" y="99" width="50" height="5" fill="${gold}"/>`
    + `<line x1="50" y1="66" x2="50" y2="92" stroke="${candle}" stroke-width="3.2"/><rect x="44.5" y="71" width="11" height="16" rx="1.5" fill="${candle}"/>`
    + `<line x1="64" y1="48" x2="64" y2="80" stroke="${candle}" stroke-width="3.2"/><rect x="58.5" y="53" width="11" height="21" rx="1.5" fill="${candle}"/>`
    + `<line x1="78" y1="34" x2="78" y2="68" stroke="${candle}" stroke-width="3.2"/><rect x="72.5" y="38" width="11" height="25" rx="1.5" fill="${candle}"/>`
}
const darkIcon = () => svg(128, 128, `<rect width="128" height="128" rx="28" fill="#0F1318"/>` + iconBody('#E3A62F', '#0F1318', '#F3F5F7'))
const lightIcon = () => svg(128, 128, `<rect width="128" height="128" rx="28" fill="#F1F3F6"/>` + iconBody('#C08A1C', '#F1F3F6', '#0A0C0F'))
// Maskable: full-bleed background (no rounded corners) so a circular/squircle
// mask never reveals transparent corners; content sits inside the safe zone.
const maskableIcon = () => svg(128, 128, `<rect width="128" height="128" fill="#0F1318"/>` + iconBody('#E3A62F', '#0F1318', '#F3F5F7'))

// ── Social card (1200×630) — film-frame lockup on the brand ground ───────────
// Rasterized to PNG (via sharp/librsvg), so ALL text is outlined to paths — a
// live <text> tagline would fall back to a random system font in the raster.
// The tagline is set in Archivo Light (the brand display font we have vendored)
// rather than the on-page mono subline, since only Archivo is available to
// outline; uppercase + tracked keeps the tape-readout feel.
function centeredWord(font, text, size, ls, y, fill, W) {
  const r = outline(font, text, size, 0, 0, ls)
  const width = r.x - ls // pen after last glyph, minus the trailing letter-space
  return { svg: `<g transform="translate(${num((W - width) / 2)},${y})"><path d="${r.d}" fill="${fill}"/></g>`, width }
}
function ogCard() {
  const W = 1200, H = 630
  const bg = `<rect width="${W}" height="${H}" fill="#0E0F11"/>`
  // Mark tile scaled up from the 128-unit icon, centered near the top third.
  const tile = 214, s = tile / 128, tx = (W - tile) / 2, ty = 96
  const mark = `<g transform="translate(${num(tx)},${ty}) scale(${num(s, 4)})">`
    + `<rect width="128" height="128" rx="28" fill="#0F1318"/>` + iconBody('#E3A62F', '#0F1318', '#F3F5F7') + `</g>`
  // Wordmark: Tape (Light) + Score (Bold), outlined, centered below the mark.
  const wmSize = 104, wmY = ty + tile + 116
  const a = outline(light, 'Tape', wmSize, 0, 0, -2.6)
  const b = outline(bold, 'Score', wmSize, a.x, 0, -2.6)
  const wmWidth = (b.x - -2.6)
  const wmX = (W - wmWidth) / 2
  const wm = `<g transform="translate(${num(wmX)},${wmY})"><path d="${a.d}" fill="#F3F5F7"/><path d="${b.d}" fill="#F3F5F7"/></g>`
  // Tagline, Archivo Light, uppercase + tracked, muted.
  const tag = centeredWord(light, 'GAME FILM FOR TRADERS', 27, 7, wmY + 66, '#8A94A0', W)
  return svg(W, H, bg + mark + wm + tag.svg)
}

mkdirSync(BRAND_OUT, { recursive: true })
mkdirSync(ICON_OUT, { recursive: true })

const files = {
  [`${BRAND_OUT}/tapescore-logo.svg`]: darkLogo(),
  [`${BRAND_OUT}/tapescore-logo-light.svg`]: lightLogo(),
  [`${BRAND_OUT}/tapescore-mark.svg`]: darkIcon(),
  [`${BRAND_OUT}/tapescore-mark-light.svg`]: lightIcon(),
  [`${BRAND_OUT}/tapescore-favicon.svg`]: darkIcon(),
}
for (const [path, content] of Object.entries(files)) writeFileSync(path, content)

// PNG icons from the (unchanged) mark.
const pngs = [
  ['icon-192.png', darkIcon(), 192],
  ['icon-512.png', darkIcon(), 512],
  ['icon-maskable-512.png', maskableIcon(), 512],
  ['apple-touch-icon.png', darkIcon(), 180],
]
await Promise.all(pngs.map(([name, s, size]) =>
  sharp(Buffer.from(s), { density: 384 }).resize(size, size).png().toFile(`${ICON_OUT}/${name}`)))

// favicon.ico — a real multi-resolution ICO (16/32/48) from the dark mark.
// sharp can't write .ico, so rasterize each size to a PNG buffer and pack them
// with png-to-ico. Rendered at high density then downscaled so the candles +
// sprocket holes stay crisp at 16px.
const faviconSvg = Buffer.from(darkIcon())
const icoPngs = await Promise.all([16, 32, 48].map(size =>
  sharp(faviconSvg, { density: 384 }).resize(size, size).png().toBuffer()))
writeFileSync(FAVICON_OUT, await pngToIco(icoPngs))

// Social cards (opengraph-image.png + twitter-image.png, identical).
const ogPng = await sharp(Buffer.from(ogCard()), { density: 192 }).resize(1200, 630).png().toBuffer()
writeFileSync(`${APP_OUT}/opengraph-image.png`, ogPng)
writeFileSync(`${APP_OUT}/twitter-image.png`, ogPng)

console.log('brand:', Object.keys(files).map(f => f.split(/[\\/]/).pop()).join(', '))
console.log('icons:', pngs.map(p => p[0]).join(', '))
console.log('favicon:', FAVICON_OUT.split(/[\\/]/).pop(), '(16/32/48)')
console.log('social:', 'opengraph-image.png, twitter-image.png (1200×630)')
