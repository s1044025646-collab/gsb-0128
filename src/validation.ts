import { AppError, ErrorCodes } from './errors.ts';

export function fail(code: keyof typeof ErrorCodes | (string & {}), message: string, details?: unknown): never {
  throw new AppError(400, code as never, message, details);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCFullYear() === Number(v.slice(0, 4));
}

export function parseDate(v: unknown, field: string): string {
  if (!isValidDate(v)) {
    fail(ErrorCodes.INVALID_DATE, `${field} must be a valid YYYY-MM-DD date`, { field, value: v });
  }
  return v;
}

export function parsePagination(query: URLSearchParams): { page: number; page_size: number } {
  let page = Number(query.get('page') ?? '1');
  let pageSize = Number(query.get('page_size') ?? '20');
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 20;
  if (pageSize > 100) pageSize = 100;
  return { page, page_size: pageSize };
}

export function paginate<T>(items: T[], page: number, page_size: number): Paginated<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / page_size));
  const start = (page - 1) * page_size;
  return {
    items: items.slice(start, start + page_size),
    page,
    page_size,
    total,
    total_pages: totalPages,
  };
}

import type { Paginated } from './domain/types.ts';
