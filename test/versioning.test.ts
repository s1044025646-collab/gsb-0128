import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, seedFixtures, teardownTestDb, type Seeded } from './helpers.ts';
import { createAnalysis, reproduceAnalysis } from '../src/domain/analysis.ts';
import { createDictionary, getDictionaryByExternalId } from '../src/domain/dictionary.ts';
import { replaceClaims } from '../src/domain/applications.ts';
import { fixtureDictionaryV2 } from '../src/fixtures.ts';

describe('versioning and reproduction', () => {
  let seeded: Seeded;

  before(() => {
    setupTestDb('versioning');
    seeded = seedFixtures();
  });
  after(() => teardownTestDb());

  it('reproduces an analysis from its frozen snapshot with identical hash and results', () => {
    const run = createAnalysis({
      application_id: seeded.app.record.id,
      dictionary_id: seeded.dict.record.id,
    });
    const reproduced = reproduceAnalysis(run.run.id);
    assert.equal(reproduced.match, true);
    assert.equal(reproduced.hash_match, true);
    assert.equal(reproduced.results_match, true);
    assert.deepEqual(reproduced.differences, []);
    assert.equal(reproduced.computed_hash, reproduced.stored_hash);
  });

  it('adding dictionary v2 does not change the v1 analysis basis or results', () => {
    const run = createAnalysis({
      application_id: seeded.app.record.id,
      dictionary_id: seeded.dict.record.id,
    });
    const beforeHash = run.run.basis_hash;
    const beforeD7 = run.references
      .find((r) => r.external_id === 'ref-d7')!
      .branch_results.find((b) => b.branch_index === 0)!;
    assert.equal(beforeD7.fully_covered, true);

    createDictionary(fixtureDictionaryV2());

    const reproduced = reproduceAnalysis(run.run.id);
    assert.equal(reproduced.match, true);
    assert.equal(reproduced.stored_hash, beforeHash);

    // v2 changes F2B relation to "related": a fresh v2 analysis must differ,
    // while the old v1 analysis still discloses F2 via equivalence.
    const v2 = getDictionaryByExternalId('dict-v2');
    const runV2 = createAnalysis({
      application_id: seeded.app.record.id,
      dictionary_id: v2.id,
    });
    const d7V2 = runV2.references
      .find((r) => r.external_id === 'ref-d7')!
      .branch_results.find((b) => b.branch_index === 0)!;
    assert.equal(d7V2.fully_covered, false);
    const f2Cell = d7V2.cells.find((c) => c.feature_code === 'F2')!;
    assert.equal(f2Cell.status, 'needs_review');

    const oldD7 = run.references
      .find((r) => r.external_id === 'ref-d7')!
      .branch_results.find((b) => b.branch_index === 0)!;
    assert.equal(oldD7.fully_covered, true);
  });

  it('amending claims creates a new analysis basis while old runs stay unchanged', () => {
    const run1 = createAnalysis({
      application_id: seeded.app.record.id,
      dictionary_id: seeded.dict.record.id,
    });
    replaceClaims(seeded.app.record.id, [
      { number: 1, type: 'independent', features: ['F1', 'F2'] },
    ]);
    const run2 = createAnalysis({
      application_id: seeded.app.record.id,
      dictionary_id: seeded.dict.record.id,
    });
    assert.notEqual(run1.run.basis_hash, run2.run.basis_hash);
    assert.equal(run1.branches.length, 7);
    assert.equal(run2.branches.length, 1);
    // old run still reproduces with its own snapshot
    assert.equal(reproduceAnalysis(run1.run.id).match, true);
  });
});
