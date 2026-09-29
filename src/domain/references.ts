import { getDb, tx } from '../db.ts';
import { AppError, ErrorCodes } from '../errors.ts';
import { nowIso } from '../clock.ts';
import { fail, isNonEmptyString, isObject, parseDate } from '../validation.ts';
import type { ReferenceBundle, ReferenceRecord } from './types.ts';

function rowToRecord(row: Record<string, unknown>): ReferenceRecord {
  return {
    id: String(row.id),
    external_id: String(row.external_id),
    title: String(row.title),
    publication_date: String(row.publication_date),
    created_at: String(row.created_at),
  };
}

export function createReference(input: unknown): { record: ReferenceBundle; duplicate: boolean } {
  if (!isObject(input)) fail(ErrorCodes.VALIDATION_FAILED, 'reference payload must be an object');
  const body = input as Record<string, unknown>;
  if (!isNonEmptyString(body.external_id)) fail(ErrorCodes.VALIDATION_FAILED, 'external_id is required', { field: 'external_id' });
  if (!isNonEmptyString(body.title)) fail(ErrorCodes.VALIDATION_FAILED, 'title is required', { field: 'title' });
  const externalId = body.external_id;
  const title = body.title;
  const publicationDate = parseDate(body.publication_date, 'publication_date');
  if (!Array.isArray(body.features)) fail(ErrorCodes.VALIDATION_FAILED, 'features must be an array', { field: 'features' });
  const features = (body.features as unknown[]).map((f) => {
    if (!isNonEmptyString(f)) fail(ErrorCodes.VALIDATION_FAILED, 'features must be non-empty strings', { field: 'features' });
    return String(f);
  });

  const d = getDb();
  const existing = d.prepare('SELECT id FROM reference WHERE external_id = ?').get(body.external_id);
  if (existing) {
    return { record: loadBundle(String(existing.id)), duplicate: true };
  }

  const id = `ref-${externalId}`;
  tx(() => {
    d.prepare('INSERT INTO reference (id, external_id, title, publication_date, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      externalId,
      title,
      publicationDate,
      nowIso(),
    );
    const stmt = d.prepare('INSERT INTO reference_disclosure (reference_id, feature_code) VALUES (?, ?)');
    for (const code of new Set(features)) stmt.run(id, code);
  });
  return { record: loadBundle(id), duplicate: false };
}

export function loadBundle(id: string): ReferenceBundle {
  const d = getDb();
  const row = d.prepare('SELECT * FROM reference WHERE id = ?').get(id);
  if (!row) throw new AppError(404, ErrorCodes.REFERENCE_NOT_FOUND, `reference ${id} not found`);
  const features = d
    .prepare('SELECT feature_code FROM reference_disclosure WHERE reference_id = ? ORDER BY feature_code')
    .all(id)
    .map((r) => String(r.feature_code));
  return { ...rowToRecord(row), features };
}

export function getReference(id: string): ReferenceBundle {
  return loadBundle(id);
}

export function getReferenceByExternalId(externalId: string): ReferenceBundle {
  const d = getDb();
  const row = d.prepare('SELECT id FROM reference WHERE external_id = ?').get(externalId);
  if (!row) throw new AppError(404, ErrorCodes.REFERENCE_NOT_FOUND, `reference external_id ${externalId} not found`);
  return loadBundle(String(row.id));
}

export function listReferences(): ReferenceRecord[] {
  return getDb()
    .prepare('SELECT * FROM reference ORDER BY publication_date, id')
    .all()
    .map(rowToRecord);
}
