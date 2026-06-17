/**
 * Trading-week date helpers. Convention: a "trading week" is Monday → Sunday
 * (ISO week), with day cards rendered Mon–Fri (the actual trading sessions)
 * and weekend rows omitted. weekStart is always the Monday in YYYY-MM-DD.
 */

import { format, startOfWeek, addDays, parseISO } from 'date-fns'

/** YYYY-MM-DD of the Monday of the ISO week containing `date`. */
export function weekStartFor(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  const monday = startOfWeek(d, { weekStartsOn: 1 })
  return format(monday, 'yyyy-MM-dd')
}

/** The 5 trading days (Mon–Fri) of the week containing `weekStart`. */
export function weekTradingDays(weekStart: string): string[] {
  const monday = parseISO(weekStart)
  return Array.from({ length: 5 }, (_, i) => format(addDays(monday, i), 'yyyy-MM-dd'))
}

/** Friday of the week containing `weekStart`. */
export function weekEnd(weekStart: string): string {
  return format(addDays(parseISO(weekStart), 4), 'yyyy-MM-dd')
}

/** Monday of the week BEFORE `weekStart`. */
export function previousWeekStart(weekStart: string): string {
  return format(addDays(parseISO(weekStart), -7), 'yyyy-MM-dd')
}

/** Monday of the week AFTER `weekStart`. */
export function nextWeekStart(weekStart: string): string {
  return format(addDays(parseISO(weekStart), 7), 'yyyy-MM-dd')
}

/** Human-readable label, e.g. "Jun 16 – Jun 20, 2026". */
export function weekLabel(weekStart: string): string {
  const monday = parseISO(weekStart)
  const friday = addDays(monday, 4)
  const sameMonth = format(monday, 'MMM') === format(friday, 'MMM')
  if (sameMonth) {
    return `${format(monday, 'MMM d')} – ${format(friday, 'd, yyyy')}`
  }
  return `${format(monday, 'MMM d')} – ${format(friday, 'MMM d, yyyy')}`
}
