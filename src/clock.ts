/**
 * Injectable clock. Tests set CURRENT_TIME; production uses the real clock.
 * Dates in this project are plain ISO calendar dates (YYYY-MM-DD); timestamps
 * are full ISO strings used only for ordering/audit.
 */
export let CURRENT_TIME: Date | null = null;

export function setClock(date: Date | string | null): void {
  CURRENT_TIME = date === null ? null : new Date(date);
}

export function now(): Date {
  return CURRENT_TIME ? new Date(CURRENT_TIME) : new Date();
}

export function nowIso(): string {
  return now().toISOString();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));
}

/** Strict calendar-date comparison: a < b. */
export function dateLt(a: string, b: string): boolean {
  return a < b;
}

/** Same calendar day (priority-date publications are not prior art). */
export function sameDay(a: string, b: string): boolean {
  return a === b;
}
