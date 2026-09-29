import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eligibilityReason, isPriorArt } from '../src/domain/dates.ts';

describe('effective date rules', () => {
  const effective = '2025-06-01';

  it('a document published before the effective date is prior art', () => {
    assert.equal(eligibilityReason('2025-05-31', effective), 'before_effective');
    assert.equal(isPriorArt('2025-05-31', effective), true);
  });

  it('same-day publication is NOT prior art (same-day rule)', () => {
    assert.equal(eligibilityReason('2025-06-01', effective), 'same_day');
    assert.equal(isPriorArt('2025-06-01', effective), false);
  });

  it('a document published after the effective date is late', () => {
    assert.equal(eligibilityReason('2025-06-02', effective), 'after_effective');
    assert.equal(isPriorArt('2025-06-02', effective), false);
  });

  it('boundary is strict: only strictly-before counts, even by one day', () => {
    assert.equal(isPriorArt('2025-05-31', effective), true);
    assert.equal(isPriorArt('2025-06-01', effective), false);
  });
});
