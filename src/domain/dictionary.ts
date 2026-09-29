import { getDb, tx } from '../db.ts';
import { AppError, ErrorCodes } from '../errors.ts';
import { nowIso } from '../clock.ts';
import { fail, isNonEmptyString, isObject } from '../validation.ts';
import type { DictionaryBundle, DictionaryInput, DictionaryRecord } from './types.ts';

function rowToRecord(row: Record<string, unknown>): DictionaryRecord {
  return {
    id: String(row.id),
    external_id: String(row.external_id),
    version_label: String(row.version_label),
    note: row.note == null ? null : String(row.note),
    created_at: String(row.created_at),
  };
}

export function createDictionary(input: unknown): { record: DictionaryBundle; duplicate: boolean } {
  if (!isObject(input)) fail(ErrorCodes.VALIDATION_FAILED, 'dictionary payload must be an object');
  const body = input as Record<string, unknown>;
  const externalId = body.external_id;
  if (!isNonEmptyString(externalId)) fail(ErrorCodes.VALIDATION_FAILED, 'external_id is required', { field: 'external_id' });
  const versionLabel = body.version_label;
  if (!isNonEmptyString(versionLabel)) fail(ErrorCodes.VALIDATION_FAILED, 'version_label is required', { field: 'version_label' });
  if (!Array.isArray(body.features) || body.features.length === 0) {
    fail(ErrorCodes.VALIDATION_FAILED, 'features must be a non-empty array', { field: 'features' });
  }
  const note = body.note == null ? undefined : String(body.note);

  const featureCodes = new Set<string>();
  const features: { code: string; name: string }[] = [];
  for (const raw of body.features as unknown[]) {
    if (!isObject(raw) || !isNonEmptyString(raw.code) || !isNonEmptyString(raw.name)) {
      fail(ErrorCodes.VALIDATION_FAILED, 'each feature must have non-empty code and name', { field: 'features' });
    }
    const code = String(raw.code);
    if (featureCodes.has(code)) fail(ErrorCodes.VALIDATION_FAILED, `duplicate feature code ${code}`, { field: 'features' });
    featureCodes.add(code);
    features.push({ code, name: String(raw.name) });
  }

  const equivalences: { code_a: string; code_b: string; relation: string }[] = [];
  if (body.equivalences != null) {
    if (!Array.isArray(body.equivalences)) fail(ErrorCodes.VALIDATION_FAILED, 'equivalences must be an array', { field: 'equivalences' });
    for (const raw of body.equivalences as unknown[]) {
      if (!isObject(raw) || !isNonEmptyString(raw.code_a) || !isNonEmptyString(raw.code_b)) {
        fail(ErrorCodes.VALIDATION_FAILED, 'each equivalence must have code_a and code_b', { field: 'equivalences' });
      }
      const a = String(raw.code_a);
      const b = String(raw.code_b);
      if (!featureCodes.has(a) || !featureCodes.has(b)) {
        fail(ErrorCodes.VALIDATION_FAILED, `equivalence references unknown feature code (${a}, ${b})`, { field: 'equivalences' });
      }
      if (a === b) fail(ErrorCodes.VALIDATION_FAILED, 'equivalence code_a and code_b must differ', { field: 'equivalences' });
      const relation = raw.relation == null ? 'equivalent' : String(raw.relation);
      equivalences.push({ code_a: a, code_b: b, relation });
    }
  }

  const mutex: { code_a: string; code_b: string }[] = [];
  if (body.mutex != null) {
    if (!Array.isArray(body.mutex)) fail(ErrorCodes.VALIDATION_FAILED, 'mutex must be an array', { field: 'mutex' });
    for (const raw of body.mutex as unknown[]) {
      if (!isObject(raw) || !isNonEmptyString(raw.code_a) || !isNonEmptyString(raw.code_b)) {
        fail(ErrorCodes.VALIDATION_FAILED, 'each mutex entry must have code_a and code_b', { field: 'mutex' });
      }
      const a = String(raw.code_a);
      const b = String(raw.code_b);
      if (!featureCodes.has(a) || !featureCodes.has(b)) {
        fail(ErrorCodes.VALIDATION_FAILED, `mutex references unknown feature code (${a}, ${b})`, { field: 'mutex' });
      }
      mutex.push({ code_a: a, code_b: b });
    }
  }

  const d = getDb();
  const existing = d.prepare('SELECT * FROM dictionary WHERE external_id = ?').get(externalId);
  if (existing) {
    return { record: loadBundle(String(existing.id)), duplicate: true };
  }

  const id = `dict-${externalId}`;
  tx(() => {
    d.prepare('INSERT INTO dictionary (id, external_id, version_label, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      externalId,
      versionLabel,
      note ?? null,
      nowIso(),
    );
    const featStmt = d.prepare('INSERT INTO feature (dictionary_id, code, name) VALUES (?, ?, ?)');
    for (const f of features) featStmt.run(id, f.code, f.name);
    const eqStmt = d.prepare('INSERT INTO equivalence (dictionary_id, code_a, code_b, relation) VALUES (?, ?, ?, ?)');
    for (const e of equivalences) eqStmt.run(id, e.code_a, e.code_b, e.relation);
    const muStmt = d.prepare('INSERT INTO feature_mutex (dictionary_id, code_a, code_b) VALUES (?, ?, ?)');
    for (const m of mutex) muStmt.run(id, m.code_a, m.code_b);
  });

  return { record: loadBundle(id), duplicate: false };
}

export function loadBundle(id: string): DictionaryBundle {
  const d = getDb();
  const row = d.prepare('SELECT * FROM dictionary WHERE id = ?').get(id);
  if (!row) throw new AppError(404, ErrorCodes.DICTIONARY_NOT_FOUND, `dictionary ${id} not found`);
  const rec = rowToRecord(row);
  const features = d
    .prepare('SELECT code, name FROM feature WHERE dictionary_id = ? ORDER BY code')
    .all(id)
    .map((r) => ({ code: String(r.code), name: String(r.name) }));
  const equivalences = d
    .prepare('SELECT code_a, code_b, relation FROM equivalence WHERE dictionary_id = ?')
    .all(id)
    .map((r) => ({ code_a: String(r.code_a), code_b: String(r.code_b), relation: String(r.relation) }));
  const mutex = d
    .prepare('SELECT code_a, code_b FROM feature_mutex WHERE dictionary_id = ?')
    .all(id)
    .map((r) => ({ code_a: String(r.code_a), code_b: String(r.code_b) }));
  return { ...rec, features, equivalences, mutex };
}

export function getDictionary(id: string): DictionaryBundle {
  return loadBundle(id);
}

export function getDictionaryByExternalId(externalId: string): DictionaryBundle {
  const d = getDb();
  const row = d.prepare('SELECT id FROM dictionary WHERE external_id = ?').get(externalId);
  if (!row) throw new AppError(404, ErrorCodes.DICTIONARY_NOT_FOUND, `dictionary external_id ${externalId} not found`);
  return loadBundle(String(row.id));
}

export function listDictionaries(): DictionaryRecord[] {
  return getDb()
    .prepare('SELECT * FROM dictionary ORDER BY created_at, id')
    .all()
    .map(rowToRecord);
}
