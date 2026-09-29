import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, seedFixtures, teardownTestDb, type Seeded } from './helpers.ts';
import { expandClaims, mutexKey } from '../src/domain/expansion.ts';

describe('claim expansion', () => {
  let seeded: Seeded;

  before(() => {
    setupTestDb('expansion');
    seeded = seedFixtures();
  });
  after(() => teardownTestDb());

  it('expands independent claim into a single branch', () => {
    const result = expandClaims(seeded.app.record.claims, new Set());
    const b1 = result.branches.find((b) => b.claim_number === 1)!;
    assert.equal(b1.features.map((f) => f.code).join(','), 'F1,F2,F3');
    assert.deepEqual(b1.path, [1]);
  });

  it('single dependency inherits all parent features with provenance', () => {
    const result = expandClaims(seeded.app.record.claims, new Set());
    const b2 = result.branches.find((b) => b.claim_number === 2)!;
    assert.deepEqual(b2.features.map((f) => f.code), ['F1', 'F2', 'F3', 'F4']);
    assert.deepEqual(b2.path, [1, 2]);
    const f4 = b2.features.find((f) => f.code === 'F4')!;
    assert.equal(f4.introduced_by, 2);
    const f1 = b2.features.find((f) => f.code === 'F1')!;
    assert.equal(f1.introduced_by, 1);
  });

  it('multiple alternative dependency keeps each alternative as a distinct branch', () => {
    const result = expandClaims(seeded.app.record.claims, new Set());
    const branches3 = result.branches.filter((b) => b.claim_number === 3);
    assert.equal(branches3.length, 2);
    assert.deepEqual(branches3[0]!.features.map((f) => f.code), ['F1', 'F2', 'F3', 'F5']);
    assert.deepEqual(branches3[1]!.features.map((f) => f.code), ['F1', 'F2', 'F3', 'F4', 'F5']);
    assert.deepEqual(branches3[0]!.path, [1, 3]);
    assert.deepEqual(branches3[1]!.path, [1, 2, 3]);
  });

  it('multiple simultaneous dependency merges all parents into one branch', () => {
    const result = expandClaims(seeded.app.record.claims, new Set());
    const branches4 = result.branches.filter((b) => b.claim_number === 4);
    assert.equal(branches4.length, 1);
    assert.deepEqual(branches4[0]!.features.map((f) => f.code), ['F1', 'F2', 'F3', 'F4', 'F7']);
    assert.deepEqual(branches4[0]!.included_claims, [1, 2, 4]);
  });

  it('multi-level dependency propagates every inherited branch', () => {
    const result = expandClaims(seeded.app.record.claims, new Set());
    const branches5 = result.branches.filter((b) => b.claim_number === 5);
    assert.equal(branches5.length, 2);
    assert.deepEqual(branches5[0]!.features.map((f) => f.code), ['F1', 'F2', 'F3', 'F5', 'F8']);
    assert.deepEqual(branches5[1]!.features.map((f) => f.code), ['F1', 'F2', 'F3', 'F4', 'F5', 'F8']);
    for (const b of branches5) {
      assert.ok(b.features.some((f) => f.code === 'F8' && f.introduced_by === 5));
    }
  });

  it('branch count: 1 + 1 + 2 + 1 + 2 = 7', () => {
    const result = expandClaims(seeded.app.record.claims, new Set());
    assert.equal(result.branches.length, 7);
    assert.deepEqual(
      result.branches.map((b) => b.index),
      [0, 1, 2, 3, 4, 5, 6],
    );
  });

  it('detects missing citations', () => {
    const result = expandClaims(seeded.broken.record.claims, new Set());
    const missing = result.findings.filter((f) => f.type === 'missing_citation');
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.type, 'missing_citation');
    if (missing[0]!.type === 'missing_citation') {
      assert.equal(missing[0]!.claim, 2);
      assert.equal(missing[0]!.missing_parent, 99);
    }
  });

  it('detects cycles', () => {
    const result = expandClaims(seeded.broken.record.claims, new Set());
    const cycles = result.findings.filter((f) => f.type === 'cycle');
    assert.equal(cycles.length, 1);
    if (cycles[0]!.type === 'cycle') {
      assert.deepEqual(cycles[0]!.claims, [3, 4, 3]);
    }
  });

  it('flags mutually exclusive features in a branch', () => {
    const mutexPairs = new Set([mutexKey('F5', 'F6')]);
    const result = expandClaims(seeded.broken.record.claims, mutexPairs);
    const b5 = result.branches.find((b) => b.claim_number === 5)!;
    assert.equal(b5.issues.length, 1);
    assert.equal(b5.issues[0]!.type, 'mutex');
    assert.equal(b5.issues[0]!.feature_a, 'F5');
    assert.equal(b5.issues[0]!.feature_b, 'F6');
  });

  it('never invents features: every branch feature traces to a claim', () => {
    const result = expandClaims(seeded.app.record.claims, new Set());
    const claimNumbers = new Set(seeded.app.record.claims.map((c) => c.number));
    for (const b of result.branches) {
      for (const f of b.features) {
        assert.ok(claimNumbers.has(f.introduced_by), `feature ${f.code} introduced by unknown claim ${f.introduced_by}`);
      }
    }
  });
});
