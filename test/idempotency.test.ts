import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.ts';
import { createDictionary, listDictionaries } from '../src/domain/dictionary.ts';
import { createApplication, listApplications } from '../src/domain/applications.ts';
import { createReference, listReferences } from '../src/domain/references.ts';
import { addReview, listReviews } from '../src/domain/reviews.ts';
import { createAnalysis } from '../src/domain/analysis.ts';
import { fixtureApplication, fixtureDictionaryV1, fixtureReferences } from '../src/fixtures.ts';

describe('idempotency', () => {
  before(() => setupTestDb('idempotency'));
  after(() => teardownTestDb());

  it('importing the same dictionary twice returns the same record', () => {
    const first = createDictionary(fixtureDictionaryV1());
    const second = createDictionary(fixtureDictionaryV1());
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.record.id, second.record.id);
    assert.equal(listDictionaries().length, 1);
  });

  it('importing the same application twice returns the same record', () => {
    const first = createApplication(fixtureApplication());
    const second = createApplication(fixtureApplication());
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.record.id, second.record.id);
    assert.equal(listApplications().length, 1);
  });

  it('importing the same reference twice returns the same record', () => {
    const first = createReference(fixtureReferences()[0]!);
    const second = createReference(fixtureReferences()[0]!);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.record.id, second.record.id);
    assert.equal(listReferences().length, 1);
  });

  it('submitting the same review twice upserts a single row', () => {
    const app = createApplication(fixtureApplication());
    const dict = createDictionary(fixtureDictionaryV1());
    const run = createAnalysis({ application_id: app.record.id, dictionary_id: dict.record.id });
    const input = {
      reviewer: 'reviewer-a',
      branch_index: 0,
      reference_id: run.references[0]!.reference_id,
      feature_code: 'F1',
      conclusion: 'confirmed_disclosed',
      note: 'first',
    };
    const r1 = addReview(run.run.id, input);
    const r2 = addReview(run.run.id, { ...input, note: 'second' });
    assert.equal(r1.id, r2.id);
    assert.equal(r2.note, 'second');
    assert.equal(listReviews(run.run.id).length, 1);
  });
});
