/**
 * Injectable clock.
 */
export interface Clock {
  now(): Date;
}

let current: Clock = { now: () => new Date() };

export function setClock(clock: Clock | null): void {
  current = clock ?? { now: () => new Date() };
}

export function now(): Date {
  return current.now();
}

export function nowIso(): string {
  return current.now().toISOString();
}

export function todayIso(): string {
  return toDateIso(current.now());
}

export function toDateIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
