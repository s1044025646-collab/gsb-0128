import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { setupTestDb, seedFixtures, teardownTestDb } from './helpers.ts';
import { startServer } from '../src/api/server.ts';
import { fixtureApplication, fixtureDictionaryV1 } from '../src/fixtures.ts';

describe('HTTP API', () => {
  let server: Server;
  let base: string;

  before(async () => {
    setupTestDb('api');
    seedFixtures();
    const started = await startServer({ host: '127.0.0.1', port: 0 });
    server = started.server;
    base = `http://${started.host}:${started.port}`;
  });

  after(() => {
    server.close();
    teardownTestDb();
  });

  async function get(path: string) {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as any };
  }

  async function post(path: string, payload: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('GET /health is ok', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  it('paginates applications', async () => {
    const page1 = await get('/applications?page=1&page_size=1');
    assert.equal(page1.status, 200);
    assert.equal(page1.body.page, 1);
    assert.equal(page1.body.page_size, 1);
    assert.equal(page1.body.items.length, 1);
    assert.ok(page1.body.total >= 2);
    assert.ok(page1.body.total_pages >= 2);
    const page2 = await get('/applications?page=2&page_size=1');
    assert.equal(page2.body.items.length, 1);
    assert.notEqual(page2.body.items[0].id, page1.body.items[0].id);
  });

  it('returns 404 with explicit code for missing application', async () => {
    const { status, body } = await get('/applications/does-not-exist');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'APPLICATION_NOT_FOUND');
  });

  it('imports applications idempotently', async () => {
    const payload = {
      external_id: 'app-api-idem',
      title: 'api idempotency test',
      filing_date: '2025-01-01',
      claims: [{ number: 1, type: 'independent', features: ['F1'] }],
    };
    const first = await post('/applications', payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, false);
    const second = await post('/applications', payload);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.application.id, first.body.application.id);
  });

  it('rejects malformed payloads with VALIDATION_FAILED', async () => {
    const { status, body } = await post('/applications', { title: 'no external id' });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(body.error.details);
  });

  it('blocks analysis when the claim graph has cycles or missing citations', async () => {
    const { status, body } = await post('/applications/app-app-bing/analyses', { dictionary_id: 'dict-dict-v1' });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'ANALYSIS_BLOCKED');
    assert.ok(body.error.details.findings.length >= 2);
  });

  it('returns 404 for unknown dictionary in analysis', async () => {
    const { status, body } = await post('/applications/app-app-jia/analyses', { dictionary_id: 'dict-nope' });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'DICTIONARY_NOT_FOUND');
  });

  it('runs a structured coverage check and returns the matrix', async () => {
    const created = await post('/applications/app-app-jia/analyses', { dictionary_id: 'dict-dict-v1', note: 'api test' });
    assert.equal(created.status, 200);
    const runId = created.body.run.id;
    assert.ok(runId);

    const coverage = await get(`/analyses/${runId}/coverage`);
    assert.equal(coverage.status, 200);
    assert.equal(coverage.body.branches.length, 7);
    const d1 = coverage.body.references.find((r: any) => r.external_id === 'ref-d1');
    const branch0 = d1.branch_results.find((b: any) => b.branch_index === 0);
    assert.equal(branch0.fully_covered, true);
    const d3 = coverage.body.references.find((r: any) => r.external_id === 'ref-d3');
    assert.equal(d3.eligible, false);
    assert.equal(d3.reason, 'same_day');

    const exportReport = await get(`/analyses/${runId}/export`);
    assert.equal(exportReport.status, 200);
    assert.equal(exportReport.body.report_type, 'structured_coverage_check');

    const reproduce = await post(`/analyses/${runId}/reproduce`, {});
    assert.equal(reproduce.status, 200);
    assert.equal(reproduce.body.match, true);
  });

  it('accepts and lists manual reviews', async () => {
    const created = await post('/applications/app-app-jia/analyses', { dictionary_id: 'dict-dict-v1' });
    const runId = created.body.run.id;
    const review = await post(`/analyses/${runId}/reviews`, {
      reviewer: 'api-reviewer',
      branch_index: 1,
      reference_id: 'ref-ref-d1',
      feature_code: 'F4',
      conclusion: 'confirmed_missing',
      note: 'api review',
    });
    assert.equal(review.status, 200);
    assert.equal(review.body.conclusion, 'confirmed_missing');
    const reviews = await get(`/analyses/${runId}/reviews`);
    assert.equal(reviews.body.length, 1);

    const bad = await post(`/analyses/${runId}/reviews`, {
      reviewer: 'api-reviewer',
      conclusion: 'not-a-conclusion',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
  });

  it('returns 404 for unknown routes', async () => {
    const { status, body } = await get('/no-such-route');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('exposes expansion findings through the API', async () => {
    const expansion = await get('/applications/app-app-bing/expansion');
    assert.equal(expansion.status, 200);
    assert.ok(expansion.body.findings.some((f: any) => f.type === 'cycle'));
    assert.ok(expansion.body.findings.some((f: any) => f.type === 'missing_citation'));
  });
});
