/**
 * Server-side helper that retries an upsert when Supabase / PostgREST reports
 * "Could not find the 'X' column of 'TABLE' in the schema cache" — usually
 * because a schema migration for a new column hasn't been applied yet.
 *
 * Each retry strips the missing column from the payload. Returns the eventual
 * result plus the list of columns that had to be dropped so the route can warn
 * the client.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface UpsertResult<T> {
  data: T | null
  error: { message: string } | null
  droppedColumns: string[]
}

const MAX_RETRIES = 10

/** Match PostgREST "Could not find the 'X' column" errors. */
function parseMissingColumn(message: string | undefined | null): string | null {
  if (!message) return null
  const m = /Could not find the ['"]([^'"]+)['"] column/i.exec(message)
  return m ? m[1] : null
}

/**
 * Resilient single-row upsert. Retries with the missing column stripped if
 * PostgREST returns a schema-cache error.
 *
 * Usage mirrors a Supabase `.upsert(...).select().single()` chain:
 *
 *   const { data, error, droppedColumns } = await resilientUpsert<TradingDay>(
 *     supabase,
 *     'trading_days',
 *     { date, prep_completed_at, eod_pnl, ... },
 *     { onConflict: 'date' },
 *   )
 */
export async function resilientUpsert<T>(
  supabase: AnyClient,
  table: string,
  initialPayload: Record<string, unknown>,
  options: { onConflict?: string } = {},
): Promise<UpsertResult<T>> {
  const droppedColumns: string[] = []
  let payload: Record<string, unknown> = { ...initialPayload }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const query = options.onConflict
      ? supabase.from(table).upsert(payload, { onConflict: options.onConflict })
      : supabase.from(table).upsert(payload)

    const { data, error } = (await query.select().single()) as {
      data: T | null
      error: { message: string } | null
    }

    if (!error) {
      return { data, error: null, droppedColumns }
    }

    const missingCol = parseMissingColumn(error.message)
    if (!missingCol || !(missingCol in payload)) {
      // Either the error wasn't about a missing column, or the column it
      // mentions isn't in our payload — nothing more we can strip.
      return { data: null, error, droppedColumns }
    }

    // Strip the offending column and try again
    droppedColumns.push(missingCol)
    const next: Record<string, unknown> = {}
    for (const k of Object.keys(payload)) {
      if (k !== missingCol) next[k] = payload[k]
    }
    payload = next
  }

  return {
    data: null,
    error: { message: `Too many missing columns; aborted after ${MAX_RETRIES} retries (dropped: ${droppedColumns.join(', ')})` },
    droppedColumns,
  }
}

interface BulkUpsertResult<T> {
  data: T[] | null
  error: { message: string } | null
  droppedColumns: string[]
}

/**
 * Resilient BULK upsert. Same retry-on-missing-column behavior as
 * `resilientUpsert`, but strips the offending column from every row in the
 * payload and supports `ignoreDuplicates`.
 *
 * Use for SC-log imports, batch trade inserts, etc.
 */
export async function resilientBulkUpsert<T>(
  supabase: AnyClient,
  table: string,
  initialPayload: Record<string, unknown>[],
  options: { onConflict?: string; ignoreDuplicates?: boolean } = {},
): Promise<BulkUpsertResult<T>> {
  const droppedColumns: string[] = []
  let payload: Record<string, unknown>[] = initialPayload.map(row => ({ ...row }))

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    if (options.onConflict) opts.onConflict = options.onConflict
    if (options.ignoreDuplicates !== undefined) opts.ignoreDuplicates = options.ignoreDuplicates

    const { data, error } = (await supabase
      .from(table)
      .upsert(payload, opts)
      .select()) as { data: T[] | null; error: { message: string } | null }

    if (!error) {
      return { data, error: null, droppedColumns }
    }

    const missingCol = parseMissingColumn(error.message)
    if (!missingCol) {
      return { data: null, error, droppedColumns }
    }
    // Check at least one row has the column
    const anyHasIt = payload.some(row => missingCol in row)
    if (!anyHasIt) {
      return { data: null, error, droppedColumns }
    }

    droppedColumns.push(missingCol)
    payload = payload.map(row => {
      const next: Record<string, unknown> = {}
      for (const k of Object.keys(row)) {
        if (k !== missingCol) next[k] = row[k]
      }
      return next
    })
  }

  return {
    data: null,
    error: { message: `Too many missing columns; aborted after ${MAX_RETRIES} retries (dropped: ${droppedColumns.join(', ')})` },
    droppedColumns,
  }
}

/**
 * Resilient update-only variant (no upsert; pure `.update()`). For routes that
 * patch an existing row by primary key.
 */
export async function resilientUpdate<T>(
  supabase: AnyClient,
  table: string,
  initialPayload: Record<string, unknown>,
  matchColumn: string,
  matchValue: unknown,
): Promise<UpsertResult<T>> {
  const droppedColumns: string[] = []
  let payload: Record<string, unknown> = { ...initialPayload }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data, error } = (await supabase
      .from(table)
      .update(payload)
      .eq(matchColumn, matchValue)
      .select()
      .single()) as { data: T | null; error: { message: string } | null }

    if (!error) {
      return { data, error: null, droppedColumns }
    }

    const missingCol = parseMissingColumn(error.message)
    if (!missingCol || !(missingCol in payload)) {
      return { data: null, error, droppedColumns }
    }

    droppedColumns.push(missingCol)
    const next: Record<string, unknown> = {}
    for (const k of Object.keys(payload)) {
      if (k !== missingCol) next[k] = payload[k]
    }
    payload = next
  }

  return {
    data: null,
    error: { message: `Too many missing columns; aborted after ${MAX_RETRIES} retries` },
    droppedColumns,
  }
}
