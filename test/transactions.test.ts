import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.ts';
import { createApplication, listApplications, replaceClaims, getApplication } from '../src/domain/applications.ts';
import { createReference, listReferences } from '../src/domain/references.ts';
import { createDictionary, listDictionaries } from '../src/domain/dictionary.ts';
import { AppError } from '../src/errors.ts';

describe('transaction rollback on invalid input', () => {
  before(() => setupTestDb('transactions'));
  after(() => teardownTestDb());

  it('rolls back an application whose claims fail validation', () => {
    assert.throws(
      () =>
        createApplication({
          external_id: 'app-bad-claims',
          title: 'bad',
          filing_date: '2025-01-01',
          claims: [
            { number: 1, type: 'independent', features: ['F1'] },
            // independent claim with a parent -> validation error
            { number: 2, type: 'independent', parent_numbers: [1], features: ['F2'] },
          ],
        }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
    assert.equal(listApplications().length, 0);
  });

  it('rolls back an application with an invalid date', () => {
    assert.throws(
      () =>
        createApplication({
          external_id: 'app-bad-date',
          title: 'bad',
          filing_date: '2025-13-40',
          claims: [{ number: 1, type: 'independent', features: ['F1'] }],
        }),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_DATE',
    );
    assert.equal(listApplications().length, 0);
  });

  it('rolls back a reference with an invalid publication date', () => {
    assert.throws(
      () =>
        createReference({
          external_id: 'ref-bad-date',
          title: 'bad',
          publication_date: 'not-a-date',
          features: ['F1'],
        }),
      (err: unknown) => err instanceof AppError && err.code === 'INVALID_DATE',
    );
    assert.equal(listReferences().length, 0);
  });

  it('rolls back a dictionary referencing unknown feature codes in equivalences', () => {
    assert.throws(
      () =>
        createDictionary({
          external_id: 'dict-bad-eq',
          version_label: 'bad',
          features: [{ code: 'F1', name: 'x' }],
          equivalences: [{ code_a: 'F1', code_b: 'F99' }],
        }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
    assert.equal(listDictionaries().length, 0);
  });

  it('keeps existing claims when claims replacement fails validation', () => {
    const app = createApplication({
      external_id: 'app-replace',
      title: 't',
      filing_date: '2025-01-01',
      claims: [{ number: 1, type: 'independent', features: ['F1'] }],
    });
    assert.throws(
      () => replaceClaims(app.record.id, [{ number: 1, type: 'independent', parent_numbers: [5], features: ['F1'] }]),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
    assert.equal(listApplications().length, 1);
    assert.equal(getApplication(app.record.id).claims.length, 1);
  });
});
