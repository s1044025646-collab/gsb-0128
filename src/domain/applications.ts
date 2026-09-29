import { getDb, tx } from '../db.ts';
import { AppError, ErrorCodes } from '../errors.ts';
import { nowIso } from '../clock.ts';
import { fail, isNonEmptyString, isObject, parseDate } from '../validation.ts';
import type { ApplicationBundle, ApplicationRecord, Claim, ClaimInput, ClaimType, DependencyType } from './types.ts';

const CLAIM_TYPES: ClaimType[] = ['independent', 'dependent'];
const DEP_TYPES: DependencyType[] = ['none', 'single', 'multiple_alternative', 'multiple_simultaneous'];

function rowToApplication(row: Record<string, unknown>): ApplicationRecord {
  return {
    id: String(row.id),
    external_id: String(row.external_id),
    title: String(row.title),
    filing_date: String(row.filing_date),
    priority_date: String(row.priority_date),
    created_at: String(row.created_at),
  };
}

function rowToClaim(row: Record<string, unknown>): Claim {
  return {
    id: String(row.id),
    application_id: String(row.application_id),
    number: Number(row.number),
    type: String(row.type) as ClaimType,
    dependency_type: String(row.dependency_type) as DependencyType,
    parent_numbers: JSON.parse(String(row.parent_numbers)) as number[],
    features: JSON.parse(String(row.features)) as string[],
    optional: Number(row.optional) === 1,
  };
}

function validateClaim(raw: unknown, index: number): ClaimInput {
  if (!isObject(raw)) fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}] must be an object`);
  const number = Number(raw.number);
  if (!Number.isInteger(number) || number < 1) {
    fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}].number must be a positive integer`, { index });
  }
  const type = raw.type;
  if (type !== 'independent' && type !== 'dependent') {
    fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}].type must be independent or dependent`, { index });
  }
  const dependencyType = (raw.dependency_type ?? (type === 'independent' ? 'none' : 'single')) as DependencyType;
  if (!DEP_TYPES.includes(dependencyType)) {
    fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}].dependency_type invalid`, { index, dependencyType });
  }
  let parentNumbers: number[] = [];
  if (raw.parent_numbers != null) {
    if (!Array.isArray(raw.parent_numbers)) fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}].parent_numbers must be an array`, { index });
    parentNumbers = (raw.parent_numbers as unknown[]).map((p) => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1) {
        fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}].parent_numbers must be positive integers`, { index });
      }
      return n;
    });
  }
  if (type === 'independent') {
    if (dependencyType !== 'none' || parentNumbers.length > 0) {
      fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}] independent claim must have no dependencies`, { index });
    }
  } else {
    if (dependencyType === 'none') fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}] dependent claim needs a dependency_type`, { index });
    if (dependencyType === 'single' && parentNumbers.length !== 1) {
      fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}] single dependency needs exactly one parent`, { index });
    }
    if ((dependencyType === 'multiple_alternative' || dependencyType === 'multiple_simultaneous') && parentNumbers.length < 2) {
      fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}] multiple dependency needs at least two parents`, { index });
    }
    if (new Set(parentNumbers).size !== parentNumbers.length) {
      fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}] parent_numbers must be unique`, { index });
    }
  }
  if (!Array.isArray(raw.features) || raw.features.length === 0) {
    fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}].features must be a non-empty array`, { index });
  }
  const features = (raw.features as unknown[]).map((f) => {
    if (!isNonEmptyString(f)) fail(ErrorCodes.VALIDATION_FAILED, `claims[${index}].features must be non-empty strings`, { index });
    return String(f);
  });
  return {
    number,
    type,
    dependency_type: dependencyType,
    parent_numbers: parentNumbers,
    features,
    optional: raw.optional === true,
  };
}

function validateClaims(rawClaims: unknown): ClaimInput[] {
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    fail(ErrorCodes.VALIDATION_FAILED, 'claims must be a non-empty array');
  }
  const claims = (rawClaims as unknown[]).map((c, i) => validateClaim(c, i));
  const numbers = new Set<number>();
  for (const c of claims) {
    if (numbers.has(c.number)) fail(ErrorCodes.VALIDATION_FAILED, `duplicate claim number ${c.number}`);
    numbers.add(c.number);
  }
  for (const c of claims) {
    for (const p of c.parent_numbers ?? []) {
      if (p === c.number) fail(ErrorCodes.VALIDATION_FAILED, `claim ${c.number} cannot depend on itself`);
    }
  }
  return claims;
}

export function createApplication(input: unknown): { record: ApplicationBundle; duplicate: boolean } {
  if (!isObject(input)) fail(ErrorCodes.VALIDATION_FAILED, 'application payload must be an object');
  const body = input as Record<string, unknown>;
  if (!isNonEmptyString(body.external_id)) fail(ErrorCodes.VALIDATION_FAILED, 'external_id is required', { field: 'external_id' });
  if (!isNonEmptyString(body.title)) fail(ErrorCodes.VALIDATION_FAILED, 'title is required', { field: 'title' });
  const externalId = body.external_id;
  const title = body.title;
  const filingDate = parseDate(body.filing_date, 'filing_date');
  const priorityDate = body.priority_date == null ? filingDate : parseDate(body.priority_date, 'priority_date');
  if (priorityDate > filingDate) {
    fail(ErrorCodes.VALIDATION_FAILED, 'priority_date cannot be after filing_date', { field: 'priority_date' });
  }
  const claims = validateClaims(body.claims);

  const d = getDb();
  const existing = d.prepare('SELECT id FROM application WHERE external_id = ?').get(body.external_id);
  if (existing) {
    return { record: loadBundle(String(existing.id)), duplicate: true };
  }

  const id = `app-${externalId}`;
  tx(() => {
    d.prepare('INSERT INTO application (id, external_id, title, filing_date, priority_date, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      externalId,
      title,
      filingDate,
      priorityDate,
      nowIso(),
    );
    insertClaims(id, claims);
  });
  return { record: loadBundle(id), duplicate: false };
}

function insertClaims(applicationId: string, claims: ClaimInput[]): void {
  const d = getDb();
  const stmt = d.prepare(
    'INSERT INTO claim (id, application_id, number, type, dependency_type, parent_numbers, features, optional) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const c of claims) {
    stmt.run(
      `claim-${applicationId}-${c.number}`,
      applicationId,
      c.number,
      c.type,
      c.dependency_type ?? 'none',
      JSON.stringify(c.parent_numbers ?? []),
      JSON.stringify(c.features),
      c.optional ? 1 : 0,
    );
  }
}

export function replaceClaims(applicationId: string, rawClaims: unknown): ApplicationBundle {
  const claims = validateClaims(rawClaims);
  const d = getDb();
  tx(() => {
    d.prepare('DELETE FROM claim WHERE application_id = ?').run(applicationId);
    insertClaims(applicationId, claims);
  });
  return loadBundle(applicationId);
}

export interface ApplicationPatch {
  title?: string;
  filing_date?: string;
  priority_date?: string;
}

export function updateApplication(applicationId: string, patch: ApplicationPatch): ApplicationBundle {
  const d = getDb();
  const app = d.prepare('SELECT * FROM application WHERE id = ?').get(applicationId);
  if (!app) throw new AppError(404, ErrorCodes.APPLICATION_NOT_FOUND, `application ${applicationId} not found`);
  const current = rowToApplication(app);
  const title = patch.title ?? current.title;
  const filingDate = patch.filing_date == null ? current.filing_date : parseDate(patch.filing_date, 'filing_date');
  const priorityDate = patch.priority_date == null ? current.priority_date : parseDate(patch.priority_date, 'priority_date');
  if (priorityDate > filingDate) {
    fail(ErrorCodes.VALIDATION_FAILED, 'priority_date cannot be after filing_date', { field: 'priority_date' });
  }
  d.prepare('UPDATE application SET title = ?, filing_date = ?, priority_date = ? WHERE id = ?').run(
    title,
    filingDate,
    priorityDate,
    applicationId,
  );
  return loadBundle(applicationId);
}

export function loadBundle(id: string): ApplicationBundle {
  const d = getDb();
  const row = d.prepare('SELECT * FROM application WHERE id = ?').get(id);
  if (!row) throw new AppError(404, ErrorCodes.APPLICATION_NOT_FOUND, `application ${id} not found`);
  const claims = d
    .prepare('SELECT * FROM claim WHERE application_id = ? ORDER BY number')
    .all(id)
    .map(rowToClaim);
  return { ...rowToApplication(row), claims };
}

export function getApplication(id: string): ApplicationBundle {
  return loadBundle(id);
}

export function getApplicationByExternalId(externalId: string): ApplicationBundle {
  const d = getDb();
  const row = d.prepare('SELECT id FROM application WHERE external_id = ?').get(externalId);
  if (!row) throw new AppError(404, ErrorCodes.APPLICATION_NOT_FOUND, `application external_id ${externalId} not found`);
  return loadBundle(String(row.id));
}

export function listApplications(): ApplicationRecord[] {
  return getDb()
    .prepare('SELECT * FROM application ORDER BY created_at, id')
    .all()
    .map(rowToApplication);
}
