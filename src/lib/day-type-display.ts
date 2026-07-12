/**
 * Display-only renames for stored day-type labels. Storage keeps the original
 * label ('GBX') so filters, aggregation drill-downs, and historical rows keep
 * matching — only chips and joined label text render the friendly name.
 * (Alpha-readiness P1: insider abbreviations don't survive first contact.)
 */
const DAY_TYPE_DISPLAY: Record<string, string> = { GBX: 'Overnight' }

export function displayDayType(label: string): string {
  return DAY_TYPE_DISPLAY[label.trim()] ?? label
}

export function displayDayTypes(labels: string[]): string {
  return labels.map(displayDayType).join(', ')
}
