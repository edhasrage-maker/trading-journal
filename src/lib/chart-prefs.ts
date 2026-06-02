/**
 * Chart preferences sync between localStorage and Supabase.
 *
 * Why this module exists:
 *  - The LiveChart on EOD / intraday pages stores appearance preferences
 *    (colors, font, indicator toggles) in localStorage. It also saves
 *    per-day zoom state under `livechart-view-v3-{symbol}-{date}` when the
 *    user clicks "Save chart view".
 *  - The journal runs on two synced Windows PCs, same Supabase backend. The
 *    chart prefs lived only on each PC, so the other one always rendered the
 *    default theme even after hours of customization.
 *  - This lib lifts those keys into a small `chart_prefs` table (KV shape,
 *    `key` = the literal localStorage key, `value` = the JSON-parsed object).
 *
 * Migration model (one-shot per PC, gated by `chart-prefs-migrated-v1`):
 *   - Fetch all rows from Supabase.
 *   - If Supabase has rows → overwrite this PC's localStorage with them.
 *     This is what the OTHER PC hits when it first opens a chart after the
 *     sync ships.
 *   - If Supabase is empty AND localStorage has chart-prefs keys → push
 *     localStorage to Supabase as the baseline. This is what THIS PC hits.
 *   - If both empty → do nothing; defaults are fine.
 *   - In every case, set the flag so the migration never runs twice on the
 *     same PC. Bump the flag key (v2, v3…) to force a re-migration.
 *
 * Runtime sync (post-migration):
 *   - Every change to localStorage chart prefs also calls
 *     `schedulePushChartPref(key, value)`. That call debounces ~1 s per key
 *     before firing a POST. Coalesces rapid color-picker drags into one
 *     write. localStorage stays the synchronous source of truth — the
 *     Supabase write is fire-and-forget.
 *
 * Keys handled here:
 *   - `livechart-prefs-v2` — the 13-field ChartPrefs appearance object.
 *   - `livechart-view-v3-{symbol}-{date}` — per-day zoom (logical range).
 *
 * Other localStorage entries (recording-commentary cache, trade-summary
 * cache, SC folder watcher state, prep autosave) are intentionally per-PC
 * and not touched here.
 */

const MIGRATION_FLAG = 'chart-prefs-migrated-v1'
const DEBOUNCE_MS = 1000                             // 1 s after last change → fire upsert

/**
 * Narrow allow-list for the keys this module ever touches. Two patterns
 * the current LiveChart.tsx code actually reads:
 *   - `livechart-prefs-v2` exact — the 13-field appearance object.
 *   - `livechart-view-v3-*` prefix — per-day saved zooms.
 * Legacy keys (livechart-prefs-v1, livechart-view-v2-*, livechart-view-*
 * with no version suffix) are ignored — the chart code stopped reading
 * them long ago. Bump this predicate when bumping the version inside
 * LiveChart.tsx (e.g., a future v4 view key).
 */
function isActiveChartPrefKey(k: string): boolean {
  return k === 'livechart-prefs-v2' || k.startsWith('livechart-view-v3-')
}

// Per-key debounce timers so rapid edits to the same key coalesce into one
// network call, but edits to DIFFERENT keys don't block each other.
const pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

// Cached migration promise so concurrent callers (e.g., two charts mounting
// at once on the EOD page) share the work and don't double-fetch.
let migrationPromise: Promise<MigrationResult> | null = null

export type MigrationResult =
  | { action: 'skipped'; reason: 'flag-set' | 'no-window' }
  | { action: 'hydrated'; rowsApplied: number }
  | { action: 'pushed'; rowsPushed: number }
  | { action: 'noop'; reason: 'empty-both-sides' }
  | { action: 'failed'; error: string }

interface ServerEntry { key: string; value: unknown; updated_at?: string }

/** Read every chart-prefs-relevant key from localStorage. Used by both the
 *  baseline-push path and the verification helpers. */
export function readAllLocalChartPrefs(): Array<{ key: string; value: unknown }> {
  if (typeof window === 'undefined') return []
  const out: Array<{ key: string; value: unknown }> = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !isActiveChartPrefKey(k)) continue
    try {
      const raw = localStorage.getItem(k)
      if (raw == null) continue
      out.push({ key: k, value: JSON.parse(raw) })
    } catch { /* skip unparseable */ }
  }
  return out
}

/** Run the one-shot migration. Safe to call from multiple chart-mount
 *  effects — the promise is memoized for the page lifetime. */
export function migrateChartPrefs(): Promise<MigrationResult> {
  if (migrationPromise) return migrationPromise
  migrationPromise = (async (): Promise<MigrationResult> => {
    if (typeof window === 'undefined') return { action: 'skipped', reason: 'no-window' }
    try {
      if (localStorage.getItem(MIGRATION_FLAG)) {
        return { action: 'skipped', reason: 'flag-set' }
      }
    } catch {
      return { action: 'skipped', reason: 'no-window' }
    }

    // Pull whatever Supabase has.
    let serverEntries: ServerEntry[] = []
    try {
      const r = await fetch('/api/chart-prefs')
      if (r.ok) {
        const body = await r.json() as { entries?: ServerEntry[] }
        serverEntries = body.entries ?? []
      }
    } catch {
      // Network failure → treat as empty-server. Worst case we re-push next
      // time. Better than nuking the user's local prefs on a transient error.
      serverEntries = []
    }

    // Branch A: server has rows → hydrate localStorage from them. Skip any
    // legacy keys the server might still hold (defensive — the active
    // POST guard rejects them now, but old rows could pre-date the guard).
    if (serverEntries.length > 0) {
      let applied = 0
      for (const e of serverEntries) {
        if (!isActiveChartPrefKey(e.key)) continue
        try { localStorage.setItem(e.key, JSON.stringify(e.value)); applied++ } catch { /* ignore */ }
      }
      try { localStorage.setItem(MIGRATION_FLAG, new Date().toISOString()) } catch { /* ignore */ }
      return { action: 'hydrated', rowsApplied: applied }
    }

    // Branch B: server is empty → push localStorage to server as baseline.
    const local = readAllLocalChartPrefs()
    if (local.length === 0) {
      try { localStorage.setItem(MIGRATION_FLAG, new Date().toISOString()) } catch { /* ignore */ }
      return { action: 'noop', reason: 'empty-both-sides' }
    }
    try {
      const r = await fetch('/api/chart-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: local }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
        return { action: 'failed', error: err?.error ?? `HTTP ${r.status}` }
      }
    } catch (e) {
      return { action: 'failed', error: e instanceof Error ? e.message : 'network' }
    }
    try { localStorage.setItem(MIGRATION_FLAG, new Date().toISOString()) } catch { /* ignore */ }
    return { action: 'pushed', rowsPushed: local.length }
  })()
  return migrationPromise
}

/**
 * Schedule a debounced upsert of one (key, value) pair. Idempotent — calling
 * repeatedly for the same key during a rapid color-drag just resets the timer.
 * Fire-and-forget — UI doesn't await this; localStorage is already updated
 * by the time this runs. Network failure is silent (next change will retry
 * by virtue of writing again).
 */
export function schedulePushChartPref(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  if (!isActiveChartPrefKey(key)) return
  const existing = pendingTimers.get(key)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    pendingTimers.delete(key)
    void fetch('/api/chart-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ key, value }] }),
    }).catch(() => { /* silent — localStorage already holds the truth */ })
  }, DEBOUNCE_MS)
  pendingTimers.set(key, t)
}

/** Test/diagnostic helper: clear the migration flag so the next page load
 *  re-runs migration. Not wired into any UI; available via console. */
export function resetChartPrefsMigrationFlag(): void {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem(MIGRATION_FLAG) } catch { /* ignore */ }
  migrationPromise = null
}
