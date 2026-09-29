import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, now, nowIso, todayIso, toDateIso } from '../src/clock.ts';

describe('injectable clock', () => {
  it('returns the real date by default', () => {
    setClock(null);
    assert.ok(now() instanceof Date);
    assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/);
  });

  it('can be frozen at a fixed instant for repeatable tests', () => {
    const frozen = new Date('2025-06-01T08:30:00.000Z');
    setClock({ now: () => frozen });
    assert.equal(nowIso(), '2025-06-01T08:30:00.000Z');
    assert.equal(todayIso(), '2025-06-01');
    assert.equal(toDateIso(frozen), '2025-06-01');
    setClock(null);
  });
});
