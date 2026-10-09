/**
 * The trade form's entry-time field is HH:MM in the browser's clock. Rebuilding
 * the timestamp from it on every save drops the seconds: an imported fill at
 * 08:18:26.696 came back as 08:18:00 just because the trader edited its notes.
 * By 2026-10-08 that had rounded 176 of the founder's 438 imported trades —
 * and seconds matter to the hold-time, cooldown and re-entry reads.
 */

/** HH:MM of a stored timestamp, as the form displays it (browser-local). */
export function entryTimeField(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5)
}

/**
 * The entry_time to save. While the field still shows the stored minute, the
 * stored timestamp is kept exactly; only a minute the trader actually changed
 * (or a new trade) is rebuilt from the field, on the page's date.
 */
export function entryTimeForSave(storedIso: string | null | undefined, field: string, date: string): string | null {
  if (storedIso && field === entryTimeField(storedIso)) return storedIso
  return field ? new Date(`${date}T${field}:00`).toISOString() : null
}
