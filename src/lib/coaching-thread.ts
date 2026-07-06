/**
 * Coaching thread — distilled, persisted session memory for the AI coach.
 *
 * The coach's long-term "memory" is already the trader's data + profile; what it
 * LACKS is continuity of its own advice. This module captures the distilled
 * action-items from a finished coach conversation — what the coach told the
 * trader to work on and what the trader committed to — so next session the coach
 * can FOLLOW UP ("last week you said you'd test 2R — did you?") instead of
 * starting cold every time.
 *
 * NOT raw transcripts: LLMs don't learn from logs, and re-feeding whole chats is
 * low-signal and costly. We store a handful of structured, reconcilable items.
 *
 * Split mirrors themes-prompt.ts / journal-language-heatmap.ts: this file is
 * PURE (types + prompt builder + parser + injection formatter + a best-effort
 * fetch). The distiller LLM call and all writes live in /api/coach/distill.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export type ThreadStatus = 'open' | 'followed_up' | 'resolved' | 'dropped'

/** Coaching categories the distiller is constrained to (keeps items groupable
 *  and prevents a sprawl of one-off labels). */
export const THREAD_CATEGORIES = [
  'exits', 'entries', 'risk', 'sizing', 'psychology', 'process', 'other',
] as const
export type ThreadCategory = (typeof THREAD_CATEGORIES)[number]

/** A persisted coaching-thread row (user_id omitted — RLS scopes it). */
export interface ThreadItem {
  id: string
  category: ThreadCategory | string
  directive: string            // what the coach advised
  commitment: string | null    // what the trader agreed to, if anything
  evidence_hint: string | null // a metric to check against next time
  status: ThreadStatus
  source: string
  created_at: string
  updated_at: string
  last_seen_at: string
}

/** A freshly distilled item the LLM proposes to ADD. */
export interface DistilledItem {
  category: ThreadCategory | string
  directive: string
  commitment?: string | null
  evidence_hint?: string | null
}

/** A reconciliation the LLM proposes for a PRIOR open item. */
export interface ThreadUpdate {
  id: string
  status: ThreadStatus
}

export interface DistillResult {
  items: DistilledItem[]
  updates: ThreadUpdate[]
}

/** Max OPEN items we keep live — the injected block stays bounded and the
 *  distiller never sees a runaway list. Oldest excess is aged out to 'dropped'. */
export const MAX_OPEN_ITEMS = 20

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * Prompt for the end-of-conversation distiller. Given the finished chat plus the
 * trader's currently-open thread items, it (a) extracts NEW durable directives /
 * commitments and (b) reconciles which prior open items this conversation shows
 * were acted on. JSON out, with a tolerant fallback parser (parseDistillResponse).
 */
export function buildDistillPrompt(
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>,
  priorOpen: ThreadItem[],
): string {
  const convo = conversation
    .filter(m => m.content?.trim())
    .map(m => `${m.role === 'user' ? 'TRADER' : 'COACH'}: ${m.content.trim()}`)
    .join('\n\n')

  const priorBlock = priorOpen.length === 0
    ? '(none — this is the first tracked conversation, or all prior items are resolved)'
    : priorOpen.map(i =>
        `- id=${i.id} [${i.category}] directive="${clip(i.directive, 240)}"${i.commitment ? ` commitment="${clip(i.commitment, 200)}"` : ''}`,
      ).join('\n')

  return `You maintain a trader's COACHING THREAD — a short, durable memory of what their coach advised and what they committed to, so the coach can follow up over time. You are reading ONE finished coach conversation and updating that thread.

Do TWO things and return JSON only.

1) EXTRACT new durable items from this conversation. An item is worth keeping ONLY if it is:
   - a concrete DIRECTIVE the coach gave the trader to work on (a change to make, a thing to test, a habit to build), OR
   - a COMMITMENT the trader made ("I'll test 2R", "I'll stop adding to losers").
   Do NOT record: one-off factual Q&A, data lookups, praise, generic advice the trader didn't engage with, or anything already covered by an existing open item below (don't duplicate — if the conversation merely repeats an open item, leave it to the reconcile step). Most conversations yield 0-3 items; many yield 0. Quality over quantity — an empty list is correct when nothing durable was decided.
   For each item give: category (one of: ${THREAD_CATEGORIES.join(', ')}), directive (imperative, <200 chars), commitment (the trader's own words if they made one, else null), evidence_hint (a specific metric/behavior to check next time, e.g. "MFE capture % on winners", "revenge re-entries per session", else null).

2) RECONCILE the trader's currently-open items against what THIS conversation shows:
   - "followed_up" = the trader reports they tried it / it came up and is in progress.
   - "resolved" = it's clearly done, fixed, or the trader has internalized it.
   - "dropped" = the coach or trader explicitly abandoned it, or it's superseded.
   Only include an item id if THIS conversation gives real evidence of a change. If a prior item wasn't touched, OMIT it (it stays open). Never invent progress.

CURRENTLY-OPEN THREAD ITEMS:
${priorBlock}

CONVERSATION:
${convo}

Return ONLY this JSON (no markdown fence, no prose):
{
  "items": [{ "category": "...", "directive": "...", "commitment": null, "evidence_hint": null }],
  "updates": [{ "id": "...", "status": "followed_up|resolved|dropped" }]
}`
}

/** Tolerant parser — strips markdown fences, extracts the outermost object,
 *  validates shape, and drops malformed entries rather than throwing. */
export function parseDistillResponse(text: string): DistillResult {
  const empty: DistillResult = { items: [], updates: [] }
  if (!text) return empty
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return empty
  let raw: unknown
  try { raw = JSON.parse(match[0]) } catch { return empty }
  if (!raw || typeof raw !== 'object') return empty
  const obj = raw as { items?: unknown; updates?: unknown }

  const items: DistilledItem[] = Array.isArray(obj.items)
    ? obj.items.flatMap((it): DistilledItem[] => {
        if (!it || typeof it !== 'object') return []
        const r = it as Record<string, unknown>
        const directive = typeof r.directive === 'string' ? r.directive.trim() : ''
        if (!directive) return []
        const category = typeof r.category === 'string' && (THREAD_CATEGORIES as readonly string[]).includes(r.category)
          ? r.category : 'other'
        const commitment = typeof r.commitment === 'string' && r.commitment.trim() ? r.commitment.trim() : null
        const evidence_hint = typeof r.evidence_hint === 'string' && r.evidence_hint.trim() ? r.evidence_hint.trim() : null
        return [{ category, directive: clip(directive, 400), commitment, evidence_hint }]
      })
    : []

  const VALID: ThreadStatus[] = ['open', 'followed_up', 'resolved', 'dropped']
  const updates: ThreadUpdate[] = Array.isArray(obj.updates)
    ? obj.updates.flatMap((u): ThreadUpdate[] => {
        if (!u || typeof u !== 'object') return []
        const r = u as Record<string, unknown>
        const id = typeof r.id === 'string' ? r.id : ''
        const status = typeof r.status === 'string' && VALID.includes(r.status as ThreadStatus) ? r.status as ThreadStatus : null
        if (!id || !status || status === 'open') return []   // 'open' is a no-op
        return [{ id, status }]
      })
    : []

  return { items, updates }
}

/**
 * Format the open thread for prompt injection into the coach context / EOD read.
 * Returns '' when there's nothing to say (so it adds zero prompt weight). Shows
 * open + recently-followed-up items; resolved/dropped are excluded by the caller.
 */
export function coachingThreadPromptBlock(items: ThreadItem[]): string {
  const live = items.filter(i => i.status === 'open' || i.status === 'followed_up')
  if (live.length === 0) return ''
  const lines = live
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))   // newest first
    .map(i => {
      const when = (i.created_at ?? '').slice(0, 10)
      const status = i.status === 'followed_up' ? ' [in progress]' : ''
      const commit = i.commitment ? ` — trader committed: "${clip(i.commitment, 160)}"` : ''
      const hint = i.evidence_hint ? ` (check: ${clip(i.evidence_hint, 100)})` : ''
      return `  • [${i.category}]${status} ${clip(i.directive, 200)}${commit}${hint} (since ${when})`
    })
    .join('\n')
  return `COACHING THREAD — WHAT YOU'VE PREVIOUSLY TOLD THIS TRADER TO WORK ON (your own prior directives + their commitments; FOLLOW UP on the open ones where the data now speaks to them — "you said you'd X, here's what the numbers show" — but do NOT re-litigate or robotically recite the whole list; weave in only what's relevant to their question):
${lines}`
}

/**
 * Best-effort fetch of the live (open + followed_up) thread for the current user.
 * RLS scopes rows to the caller, so no user filter is needed. Returns [] on any
 * error — including a missing table pre-migration (42P01 / PGRST205) — so the
 * feature is a silent no-op until the migration is applied.
 */
export async function fetchOpenThread(supabase: AnyClient): Promise<ThreadItem[]> {
  try {
    const { data, error } = await supabase
      .from('coaching_thread')
      .select('id, category, directive, commitment, evidence_hint, status, source, created_at, updated_at, last_seen_at')
      .in('status', ['open', 'followed_up'])
      .order('created_at', { ascending: false })
      .limit(MAX_OPEN_ITEMS)
    if (error || !data) return []
    return data as ThreadItem[]
  } catch {
    return []
  }
}
