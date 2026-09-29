import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, seedFixtures, teardownTestDb, type Seeded } from './helpers.ts';
import { createAnalysis, loadAnalysis, type AnalysisResult } from '../src/domain/analysis.ts';
import { AppError } from '../src/errors.ts';
import { createApplication } from '../src/domain/applications.ts';

describe('structured coverage check', () => {
  let seeded: Seeded;
  let result: AnalysisResult;

  before(() => {
    setupTestDb('coverage');
    seeded = seedFixtures();
    result = createAnalysis({
      application_id: seeded.app.record.id,
      dictionary_id: seeded.dict.record.id,
      note: 'coverage test run',
    });
  });
  after(() => teardownTestDb());

  const ref = (externalId: string) => result.references.find((r) => r.external_id === externalId)!;
  const cell = (externalId: string, branch: number, code: string) =>
    ref(externalId).branch_results.find((b) => b.branch_index === branch)!.cells.find((c) => c.feature_code === code)!;

  it('uses priority date as the default effective date', () => {
    assert.equal(result.run.effective_date, '2025-06-01');
  });

  it('marks the same-day document D3 as not eligible', () => {
    const d3 = ref('ref-d3');
    assert.equal(d3.eligible, false);
    assert.equal(d3.reason, 'same_day');
    for (const br of d3.branch_results) assert.equal(br.fully_covered, false);
  });

  it('marks the late document D4 as not eligible', () => {
    const d4 = ref('ref-d4');
    assert.equal(d4.eligible, false);
    assert.equal(d4.reason, 'after_effective');
  });

  it('D1 fully covers claim 1 and claim 2 branches', () => {
    const d1 = ref('ref-d1');
    assert.equal(d1.branch_results.find((b) => b.branch_index === 0)!.fully_covered, true);
    assert.equal(d1.branch_results.find((b) => b.branch_index === 1)!.fully_covered, true);
    assert.equal(cell('ref-d1', 0, 'F2').via, 'direct');
  });

  it('D2 covers the alternative branch of claim 3 but not the claim-2 branch', () => {
    const d2 = ref('ref-d2');
    assert.equal(d2.branch_results.find((b) => b.branch_index === 2)!.fully_covered, true);
    assert.equal(d2.branch_results.find((b) => b.branch_index === 3)!.fully_covered, false);
    assert.equal(cell('ref-d2', 3, 'F4').status, 'missing');
  });

  it('D7 covers F2 through an explicit dictionary equivalence, not direct disclosure', () => {
    const d7 = ref('ref-d7');
    assert.equal(d7.branch_results.find((b) => b.branch_index === 0)!.fully_covered, true);
    const f2 = cell('ref-d7', 0, 'F2');
    assert.equal(f2.status, 'disclosed');
    assert.equal(f2.via, 'equivalence');
    assert.equal(f2.matched_code, 'F2B');
    const f1 = cell('ref-d7', 0, 'F1');
    assert.equal(f1.via, 'direct');
  });

  it('D8 unknown feature F999 turns otherwise-missing F3 into needs_review, never into disclosed', () => {
    const d8 = ref('ref-d8');
    const f3 = cell('ref-d8', 0, 'F3');
    assert.equal(f3.status, 'needs_review');
    assert.equal(f3.via, null);
    assert.match(f3.note ?? '', /F999/);
    assert.deepEqual(d8.unknown_disclosed_features, ['F999']);
    // branch 1 also lacks F4; the unknown feature poisons it into needs_review too
    assert.equal(cell('ref-d8', 1, 'F4').status, 'needs_review');
    assert.equal(cell('ref-d8', 1, 'F3').status, 'needs_review');
  });

  it('never combines documents: D5 and D6 collectively cover claim 1 but neither covers it alone', () => {
    const d5 = ref('ref-d5');
    const d6 = ref('ref-d6');
    assert.equal(d5.branch_results.find((b) => b.branch_index === 0)!.fully_covered, false);
    assert.equal(d6.branch_results.find((b) => b.branch_index === 0)!.fully_covered, false);
    assert.equal(cell('ref-d5', 0, 'F3').status, 'missing');
    assert.equal(cell('ref-d6', 0, 'F1').status, 'missing');
    assert.equal(cell('ref-d6', 0, 'F2').status, 'missing');
  });

  it('each document is evaluated alone: D1 covers claim 1 even though D5+D6 also collectively do', () => {
    const d1 = ref('ref-d1');
    assert.equal(d1.branch_results.find((b) => b.branch_index === 0)!.fully_covered, true);
  });

  it('scope restricts which references are checked', () => {
    const scoped = createAnalysis({
      application_id: seeded.app.record.id,
      dictionary_id: seeded.dict.record.id,
      scope: ['ref-d1'],
    });
    assert.equal(scoped.references.length, 1);
    assert.equal(scoped.references[0]!.external_id, 'ref-d1');
  });

  it('analysis is blocked when the claim graph has cycles or missing citations', () => {
    assert.throws(
      () =>
        createAnalysis({
          application_id: seeded.broken.record.id,
          dictionary_id: seeded.dict.record.id,
        }),
      (err: unknown) => err instanceof AppError && err.status === 409 && err.code === 'ANALYSIS_BLOCKED',
    );
  });

  it('unknown claim features are rejected instead of guessed', () => {
    const bad = createApplication({
      external_id: 'app-unknown-feat',
      title: 'bad app',
      filing_date: '2025-01-01',
      claims: [{ number: 1, type: 'independent', features: ['F1', 'F999'] }],
    });
    assert.throws(
      () =>
        createAnalysis({
          application_id: bad.record.id,
          dictionary_id: seeded.dict.record.id,
        }),
      (err: unknown) => err instanceof AppError && err.status === 422 && err.code === 'UNKNOWN_CLAIM_FEATURE',
    );
  });

  it('evidence is item-by-item: every required feature has a cell', () => {
    const d1 = ref('ref-d1');
    const branch0Cells = d1.branch_results.find((b) => b.branch_index === 0)!.cells;
    assert.deepEqual(
      branch0Cells.map((c) => c.feature_code).sort(),
      ['F1', 'F2', 'F3'],
    );
    const branch1Cells = d1.branch_results.find((b) => b.branch_index === 1)!.cells;
    assert.deepEqual(
      branch1Cells.map((c) => c.feature_code).sort(),
      ['F1', 'F2', 'F3', 'F4'],
    );
  });
});
