// Read-only backup of a Supabase project's DATA tables to JSON files.
//
// Exports table ROWS only — it does NOT touch auth users / emails, so it's
// limited to trade data, tags, days, market context, etc. Read-only: the only
// thing it writes is local JSON files.
//
// Usage:
//   node scripts/backup-db.cjs --env .env.local --ref gppxmkvceyrnljbhfwgl \
//        --exclude ohlcv_bars,bar_imports --out <dir>
//
// --ref is a safety guard: the script refuses to run unless the project URL in
// the given env file contains that ref (so it can never point at the wrong DB).
const fs = require('fs')
const path = require('path')

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}

const ENVFILE = arg('--env', '.env.local')
const EXPECT_REF = arg('--ref', '')
const EXCLUDE = (arg('--exclude', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const OUT = arg('--out', '.')

// --- load the env file ---
for (const line of fs.readFileSync(ENVFILE, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error(`Missing Supabase URL/service key in ${ENVFILE}`); process.exit(1) }
if (EXPECT_REF && !URL.includes(EXPECT_REF)) {
  console.error(`Refusing to run: ${ENVFILE} points at ${URL}, but expected ref "${EXPECT_REF}".`)
  process.exit(1)
}

const { createClient } = require('@supabase/supabase-js')
const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const DATA_DIR = path.join(OUT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const PAGE = 1000

async function listTables() {
  const res = await fetch(URL + '/rest/v1/', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } })
  const doc = await res.json()
  const defs = doc.definitions || (doc.components && doc.components.schemas) || {}
  return Object.keys(defs).filter(t => t && !EXCLUDE.includes(t))
}

async function dumpTable(table) {
  const rows = []
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from(table).select('*').range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) return { table, error: error.message }
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
  }
  fs.writeFileSync(path.join(DATA_DIR, table + '.json'), JSON.stringify(rows))
  return { table, count: rows.length }
}

;(async () => {
  const ref = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || URL
  const manifest = { project: ref, exported_at_utc: new Date().toISOString(), excluded: EXCLUDE, tables: {}, errors: [] }
  const tables = await listTables()
  for (const t of tables) {
    const r = await dumpTable(t)
    if (r.error) { manifest.errors.push(`${t}: ${r.error}`); console.log(`  ${t}: ERROR ${r.error}`) }
    else { manifest.tables[t] = r.count; console.log(`  ${t}: ${r.count}`) }
  }
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
  const total = Object.values(manifest.tables).reduce((a, b) => a + b, 0)
  console.log(`\nBackup done: ${Object.keys(manifest.tables).length} tables, ${total} rows, ${manifest.errors.length} errors → ${OUT}`)
  if (manifest.errors.length) process.exitCode = 2
})()
