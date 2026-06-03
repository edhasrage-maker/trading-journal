// One-shot: convert any trades.recording_commentary rows that were stored
// as a raw string (a few June 1 rows from an early version of the persistence
// code) into the current { text, video_file, model, generated_at } shape.
// Idempotent — already-object rows are skipped. video_file is set to
// "<unknown>" since the original recording filename isn't recoverable for
// those legacy rows; the component renders them anyway because we treat the
// string case as a "best-effort fallback" path.
const fs = require('fs')
for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { createClient } = require('@supabase/supabase-js')
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  // Paginate over every trade with a non-null recording_commentary; filter
  // to the string-shape rows client-side since PostgREST can't distinguish
  // jsonb-string from jsonb-object via a simple filter.
  const fixes = []
  for (let p = 0; p < 50; p++) {
    const { data: rows, error } = await sb
      .from('trades')
      .select('id, recording_commentary, updated_at')
      .not('recording_commentary', 'is', null)
      .order('id')
      .range(p * 1000, p * 1000 + 999)
    if (error) throw error
    if (!rows || rows.length === 0) break
    for (const r of rows) {
      if (typeof r.recording_commentary === 'string' && r.recording_commentary.trim()) {
        fixes.push({ id: r.id, text: r.recording_commentary, updated_at: r.updated_at })
      }
    }
    if (rows.length < 1000) break
  }

  console.log(`Found ${fixes.length} rows in legacy string shape.`)
  if (fixes.length === 0) return

  const generatedAt = new Date().toISOString()
  let ok = 0
  for (const f of fixes) {
    const { error } = await sb
      .from('trades')
      .update({
        recording_commentary: {
          text: f.text,
          video_file: '<unknown>',           // recording name not recoverable from legacy rows
          model: 'claude-sonnet-4-6',
          generated_at: f.updated_at ?? generatedAt,
          normalized_from_legacy_string: true,
        },
      })
      .eq('id', f.id)
    if (error) console.error(' [fail]', f.id, error.message)
    else ok++
  }
  console.log(`Normalized ${ok}/${fixes.length} rows.`)
}

main().catch(e => { console.error(e); process.exit(1) })
