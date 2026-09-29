import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCodes } from '../errors.ts';
import { parsePagination, paginate } from '../validation.ts';
import { listApplications, createApplication, getApplication, updateApplication, replaceClaims } from '../domain/applications.ts';
import { listReferences, createReference, getReference } from '../domain/references.ts';
import { listDictionaries, createDictionary, getDictionary } from '../domain/dictionary.ts';
import { expandClaims, mutexKey } from '../domain/expansion.ts';
import { createAnalysis, listAnalyses, loadAnalysis, reproduceAnalysis } from '../domain/analysis.ts';
import { addReview, listReviews } from '../domain/reviews.ts';
import { buildReport } from '../domain/report.ts';
import { getDataDir } from '../paths.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: ErrorCodes.INTERNAL, message, details: null } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new AppError(413, ErrorCodes.VALIDATION_FAILED, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError(400, ErrorCodes.VALIDATION_FAILED, 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

type Handler = (params: Record<string, string>, query: URLSearchParams, body: unknown) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  const paramNames: string[] = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([a-z_]+)/g, (_m, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, pattern: regex, paramNames, handler });
}

function expansionOf(appId: string, dictionaryId: string | undefined) {
  const app = getApplication(appId);
  let mutexPairs = new Set<string>();
  if (dictionaryId) {
    const dict = getDictionary(dictionaryId);
    mutexPairs = new Set(dict.mutex.map((m) => mutexKey(m.code_a, m.code_b)));
  }
  return expandClaims(app.claims, mutexPairs);
}

route('GET', '/health', () => ({ status: 'ok', service: 'patent-claim-backend', time: new Date().toISOString() }));

route('GET', '/applications', (_p, query) => {
  const { page, page_size } = parsePagination(query);
  return paginate(listApplications(), page, page_size);
});

route('POST', '/applications', (_p, _q, body) => {
  const { record, duplicate } = createApplication(body);
  return { application: record, duplicate };
});

route('GET', '/applications/:id', (p) => getApplication(p.id!));

route('PATCH', '/applications/:id', (p, _q, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return updateApplication(p.id!, {
    title: b.title == null ? undefined : String(b.title),
    filing_date: b.filing_date == null ? undefined : String(b.filing_date),
    priority_date: b.priority_date == null ? undefined : String(b.priority_date),
  });
});

route('PUT', '/applications/:id/claims', (p, _q, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.claims)) throw new AppError(400, ErrorCodes.VALIDATION_FAILED, 'claims array required', { field: 'claims' });
  return replaceClaims(p.id!, b.claims);
});

route('GET', '/applications/:id/expansion', (p, query) => expansionOf(p.id!, query.get('dictionary_id') ?? undefined));

route('GET', '/applications/:id/citations', (p) => expansionOf(p.id!, undefined).findings);

route('GET', '/references', (_p, query) => {
  const { page, page_size } = parsePagination(query);
  return paginate(listReferences(), page, page_size);
});

route('POST', '/references', (_p, _q, body) => {
  const { record, duplicate } = createReference(body);
  return { reference: record, duplicate };
});

route('GET', '/references/:id', (p) => getReference(p.id!));

route('GET', '/dictionaries', (_p, query) => {
  const { page, page_size } = parsePagination(query);
  return paginate(listDictionaries(), page, page_size);
});

route('POST', '/dictionaries', (_p, _q, body) => {
  const { record, duplicate } = createDictionary(body);
  return { dictionary: record, duplicate };
});

route('GET', '/dictionaries/:id', (p) => getDictionary(p.id!));

route('POST', '/applications/:id/analyses', (p, _q, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return createAnalysis({
    application_id: p.id!,
    dictionary_id: b.dictionary_id == null ? undefined : String(b.dictionary_id),
    effective_date: b.effective_date == null ? undefined : String(b.effective_date),
    scope: b.scope as string[] | 'all' | undefined,
    note: b.note == null ? undefined : String(b.note),
  });
});

route('GET', '/analyses', (_p, query) => {
  const { page, page_size } = parsePagination(query);
  return paginate(listAnalyses(), page, page_size);
});

route('GET', '/analyses/:id', (p) => loadAnalysis(p.id!));

route('GET', '/analyses/:id/coverage', (p) => {
  const result = loadAnalysis(p.id!);
  return {
    run: result.run,
    branches: result.branches,
    references: result.references.map((r) => ({
      reference_id: r.reference_id,
      external_id: r.external_id,
      title: r.title,
      publication_date: r.publication_date,
      eligible: r.eligible,
      reason: r.reason,
      unknown_count: r.unknown_count,
      unknown_disclosed_features: r.unknown_disclosed_features,
      branch_results: r.branch_results,
    })),
  };
});

route('GET', '/analyses/:id/reviews', (p) => listReviews(p.id!));

route('POST', '/analyses/:id/reviews', (p, _q, body) => addReview(p.id!, body));

route('GET', '/analyses/:id/export', (p) => buildReport(p.id!));

route('POST', '/analyses/:id/reproduce', (p) => reproduceAnalysis(p.id!));

export function createHttpServer(): Server {
  return createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const matched = routes.find((r) => r.method === method && r.pattern.test(pathname));
      if (!matched) {
        sendJson(res, 404, { error: { code: ErrorCodes.NOT_FOUND, message: `no route for ${method} ${pathname}`, details: null } });
        return;
      }
      const match = matched.pattern.exec(pathname)!;
      const params: Record<string, string> = {};
      matched.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]!);
      });
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : undefined;
      const result = matched.handler(params, url.searchParams, body);
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, err);
    }
  });
}

export interface StartedServer {
  server: Server;
  host: string;
  port: number;
}

export function startServer(options: { host?: string; port?: number; dataDir?: string } = {}): Promise<StartedServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 0;
  const server = createHttpServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to get server address'));
        return;
      }
      const port = addr.port;
      const dataDir = options.dataDir ?? getDataDir();
      writeFileSync(join(dataDir, 'server.port'), String(port), 'utf8');
      writeFileSync(join(dataDir, 'server.host'), host, 'utf8');
      resolve({ server, host, port });
    });
  });
}
