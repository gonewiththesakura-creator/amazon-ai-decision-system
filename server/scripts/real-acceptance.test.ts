import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedAcceptanceRequest, runAcceptanceCli as rawRunAcceptanceCli } from './real-acceptance.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const runAcceptanceCli: typeof rawRunAcceptanceCli = (args, dependencies) =>
  rawRunAcceptanceCli([...args, '--confirm-plan', RUN_ID], dependencies);
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const HASHES = ['a', 'b', 'c', 'd', 'e'].map((value) => value.repeat(64));
const PRIVATE_CANARY = 'PRIVATE_ASIN_B0SECRET01';
const SECRET_CANARY = 'secret-key=never-print-this';

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.close();
  await once(server, 'close');
  server = undefined;
});

describe('real SellerSprite acceptance runner', () => {
  it('defaults to a call plan with no connection test or remote execution', async () => {
    const api = await startApi();
    const output: string[] = [];
    expect(await rawRunAcceptanceCli(['--base-url', api.baseUrl, '--month', '202609'], {
      writeOutput: (value) => output.push(value),
    })).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({dryRun:true});
    expect(api.requests).not.toContain('POST /api/integrations/sellersprite/test');
  });
  it('allows only the intended read and validation write routes', () => {
    for (const [method, path] of [
      ['POST', '/api/go-live/backup'],
      ['POST', '/api/go-live/cleanup'],
      ['POST', '/api/go-live/activate'],
      ['POST', '/api/owned-products/owned-1/competitor-candidates/candidate-1/confirm'],
      ['POST', '/api/owned-products/owned-1/competitor-candidates/candidate-1/reject'],
      ['DELETE', '/api/research-jobs/job-1'],
      ['GET', '/api/go-live/preview'],
      ['POST', '/api/research-jobs/job-1/evidence'],
      ['POST', '/api/research-jobs/job-1/run/../../go-live/cleanup'],
    ]) {
      expect(isAllowedAcceptanceRequest(method, path)).toBe(false);
    }
    expect(isAllowedAcceptanceRequest('POST', '/api/integrations/sellersprite/sync/critical'))
      .toBe(true);
    expect(isAllowedAcceptanceRequest('GET', `/api/dashboard/executive/run-proof/${RUN_ID}`))
      .toBe(true);
  });

  it('runs the complete child-SKU chain and prints only allowlisted readiness data', async () => {
    const api = await startApi();
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl,
      '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(0);
    expect(output).toHaveLength(1);
    const summary = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(summary).toEqual({
      ok: true,
      acceptanceScope: 'critical_market_and_owned_skus',
      manualCompetitorReview: 'confirmed',
      checks: {
        preflight: true,
        connection: true,
        schemas: true,
        criticalSync: true,
        secondaryCoverage: true,
        workflows: true,
        evidence: true,
        dashboard: true,
        verification: true,
      },
      counts: {
        tools: 9,
        requiredCapabilities: 5,
        schemaHashes: 5,
        ownedProducts: 2,
        candidateDiscoveryProducts: 2,
        candidateDiscoveryFailures: 0,
        competitorCandidates: 1,
        directCompetitors: 1,
        refreshedDirectCompetitors: 1,
        failedDirectCompetitors: 0,
        primaryMarketHistoryDays: 92,
        runLinkedCandidateGroups: 1,
        confirmedDirectCompetitors: 1,
        marketSnapshots: 2,
        productSnapshots: 4,
        jobs: 3,
        evidence: 3,
        dashboardOwnedProducts: 3,
        verifiedDashboardOwnedProducts: 2,
        verifiedEvidenceEntities: 3,
        requiredEvidenceEntities: 3,
      },
      runId: RUN_ID,
      schemaHashes: HASHES,
    });
    const safeLabels = new Set([RUN_ID, 'critical_market_and_owned_skus', 'confirmed']);
    expect(allStringValues(summary).every((value) => (
      safeLabels.has(value) || /^[a-f0-9]{64}$/.test(value)
    ))).toBe(true);
    expect(output[0]).not.toMatch(/PRIVATE|SECRET|ASIN|title|endpoint|https?:\/\//i);
    expect(api.requests).toEqual([
      'GET /api/settings',
      'GET /api/markets',
      'POST /api/integrations/sellersprite/test',
      'POST /api/integrations/sellersprite/sync/critical',
      `GET /api/integrations/sellersprite/sync/critical/${RUN_ID}/roster`,
      `GET /api/integrations/sellersprite/capabilities?runId=${RUN_ID}`,
      'GET /api/dashboard/executive?range=30D',
      `GET /api/dashboard/executive/run-proof/${RUN_ID}`,
      'POST /api/research-jobs',
      'POST /api/research-jobs/job-1/run',
      'POST /api/research-jobs',
      'POST /api/research-jobs/job-2/run',
      'POST /api/research-jobs',
      'POST /api/research-jobs/job-3/run',
      'GET /api/research-jobs/job-1/evidence',
      'GET /api/research-jobs/job-2/evidence',
      'GET /api/research-jobs/job-3/evidence',
      'GET /api/go-live/verify',
    ]);
    expect(api.requests.join('\n')).not.toMatch(
      /go-live\/(?:preview|backup|cleanup|activate)|competitor-candidates\/.*\/(?:confirm|reject)/,
    );
  });

  it('reports secondary coverage without claiming human competitor review', async () => {
    const api = await startApi({
      candidateCoverage: { status: 'success', total: 2, success: 2, failed: 0, candidates: 3 },
      competitorCoverage: { status: 'partial', total: 2, success: 1, failed: 1 },
    });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: true,
      acceptanceScope: 'critical_market_and_owned_skus',
      manualCompetitorReview: 'confirmed',
      checks: { secondaryCoverage: true },
      counts: {
        candidateDiscoveryProducts: 2,
        candidateDiscoveryFailures: 0,
        competitorCandidates: 3,
        directCompetitors: 2,
        refreshedDirectCompetitors: 1,
        failedDirectCompetitors: 1,
      },
    });
    expect(api.requests.join('\n')).not.toMatch(/competitor-candidates\/.*\/(?:confirm|reject)/);
  });

  it('rejects a successful discovery run that produced no run-linked candidates', async () => {
    const api = await startApi({
      candidateCoverage: { status: 'success', total: 2, success: 2, failed: 0, candidates: 0 },
    });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { criticalSync: true, secondaryCoverage: false, dashboard: false },
      counts: { competitorCandidates: 0 },
    });
    expect(api.requests).not.toContain('GET /api/dashboard/executive?range=30D');
    expect(api.requests).not.toContain('POST /api/research-jobs');
  });

  it('rejects candidate coverage for a different owned-SKU roster before dashboard or jobs', async () => {
    const api = await startApi({
      candidateCoverage: { status: 'success', total: 1, success: 1, failed: 0, candidates: 1 },
    });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false, checks: { criticalSync: true, secondaryCoverage: false, dashboard: false },
    });
    expect(api.requests).not.toContain('GET /api/dashboard/executive?range=30D');
    expect(api.requests).not.toContain('POST /api/research-jobs');
  });

  it('rejects a full acceptance run without a current direct-competitor roster', async () => {
    const api = await startApi({
      competitorCoverage: { status: 'success', total: 0, success: 0, failed: 0 },
    });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { criticalSync: true, secondaryCoverage: false, dashboard: false },
      counts: { directCompetitors: 0 },
    });
  });

  it.each([
    ['89 days of primary-market history', {
      primaryMarketHistoryDays: 89,
      hasPrimaryMarketHistory90d: false,
      confirmedDirectCompetitors: 1,
    }],
    ['no human-confirmed active direct competitor', {
      primaryMarketHistoryDays: 92,
      hasPrimaryMarketHistory90d: true,
      confirmedDirectCompetitors: 0,
    }],
  ])('rejects otherwise complete acceptance with %s', async (_case, verification) => {
    const api = await startApi({ verification });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { verification: false },
    });
  });

  it('keeps observed secondary failure counts when the run cannot be accepted', async () => {
    const api = await startApi({
      candidateCoverage: { status: 'partial', total: 2, success: 1, failed: 1, candidates: 2 },
      competitorCoverage: { status: 'failed', total: 2, success: 0, failed: 2 },
    });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { criticalSync: true, secondaryCoverage: false, dashboard: false },
      counts: {
        candidateDiscoveryProducts: 1,
        candidateDiscoveryFailures: 1,
        competitorCandidates: 2,
        directCompetitors: 2,
        refreshedDirectCompetitors: 0,
        failedDirectCompetitors: 2,
      },
    });
    expect(api.requests).not.toContain('GET /api/dashboard/executive?range=30D');
  });

  it('does not print an HTTP error body, endpoint, private data, or secret canaries', async () => {
    const api = await startApi({
      failPath: '/api/integrations/sellersprite/sync/critical',
      failureBody: { error: `${SECRET_CANARY} ${PRIVATE_CANARY} https://private.invalid/path` },
    });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl,
      '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(SECRET_CANARY);
    expect(output[0]).not.toContain(PRIVATE_CANARY);
    expect(output[0]).not.toMatch(/https?:\/\//);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { preflight: true, connection: true, schemas: false, criticalSync: false },
    });
    expect(api.requests).not.toContain('POST /api/research-jobs');
    expect(api.requests).not.toContain('GET /api/dashboard/executive?range=30D');
    expect(api.requests).not.toContain('GET /api/go-live/verify');
  });

  it('rejects cross-run Evidence after dashboard validation and before verification', async () => {
    const api = await startApi({ evidenceRunId: OTHER_RUN_ID });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl,
      '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { workflows: true, evidence: false, dashboard: true, verification: false },
      runId: RUN_ID,
    });
    expect(api.requests).toContain('GET /api/dashboard/executive?range=30D');
    expect(api.requests).not.toContain('GET /api/go-live/verify');
  });

  it('rejects a job with Mock Evidence even when the same job has current-run MCP Evidence', async () => {
    const api = await startApi({ includeMockEvidence: true });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { workflows: true, dashboard: true, evidence: false, verification: false },
      runId: RUN_ID,
    });
    expect(output[0]).not.toContain(PRIVATE_CANARY);
    expect(api.requests).not.toContain('GET /api/go-live/verify');
  });

  it('rejects a dashboard missing an authoritative run-roster product before reading Evidence', async () => {
    const api = await startApi({ dashboardProductIds: ['owned-1'] });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl,
      '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { workflows: false, dashboard: false, evidence: false, verification: false },
      runId: RUN_ID,
    });
    expect(api.requests.some((item) => item.endsWith('/evidence'))).toBe(false);
    expect(api.requests).not.toContain('GET /api/go-live/verify');
  });

  it('rejects a dashboard that duplicates an authoritative run-roster product', async () => {
    const api = await startApi({ dashboardProductIds: ['owned-1', 'owned-1', 'owned-2'] });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl,
      '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { workflows: false, dashboard: false, evidence: false },
    });
    expect(api.requests.some((item) => item.endsWith('/evidence'))).toBe(false);
  });

  it('rejects a stale or Mock-backed dashboard read path before creating jobs', async () => {
    const api = await startApi({ dashboardProof: {
      passed: false, marketVerified: true, verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    } });
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl, '--month', '202609',
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      checks: { criticalSync: true, schemas: true, dashboard: false, workflows: false, evidence: false },
    });
    expect(api.requests).toContain(`GET /api/dashboard/executive/run-proof/${RUN_ID}`);
    expect(api.requests).not.toContain('POST /api/research-jobs');
  });

  it('requires an explicit observation month without making a request', async () => {
    const api = await startApi();
    const output: string[] = [];

    const exitCode = await runAcceptanceCli([
      '--base-url', api.baseUrl,
    ], { writeOutput: (value) => output.push(value) });

    expect(exitCode).toBe(1);
    expect(api.requests).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, checks: { preflight: false } });
  });

  it('refuses redirects from the local API without following the destination', async () => {
    const external = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { role: 'admin' } }));
    });
    external.listen(0, '127.0.0.1');
    await once(external, 'listening');
    const externalAddress = external.address() as AddressInfo;
    let externalHits = 0;
    external.on('request', () => { externalHits += 1; });
    const api = await startApi({
      redirectPath: '/api/settings',
      redirectLocation: `http://127.0.0.1:${externalAddress.port}/redirected`,
    });
    const output: string[] = [];
    try {
      const exitCode = await runAcceptanceCli([
        '--base-url', api.baseUrl, '--month', '202609',
      ], { writeOutput: (value) => output.push(value) });
      expect(exitCode).toBe(1);
      expect(externalHits).toBe(0);
      expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, checks: { preflight: false } });
      expect(output[0]).not.toContain(api.baseUrl);
    } finally {
      external.close();
      await once(external, 'close');
    }
  });
});

interface ApiOptions {
  failPath?: string;
  failureBody?: unknown;
  evidenceRunId?: string;
  dashboardProductIds?: string[];
  includeMockEvidence?: boolean;
  candidateCoverage?: {
    status: 'success' | 'partial' | 'failed'; total: number; success: number; failed: number;
    candidates: number;
  };
  competitorCoverage?: {
    status: 'success' | 'partial' | 'failed'; total: number; success: number; failed: number;
  };
  dashboardProof?: {
    passed: boolean;
    marketVerified: boolean;
    verifiedOwnedProducts: number;
    requiredOwnedProducts: number;
  };
  verification?: Partial<{
    primaryMarketHistoryDays: number;
    hasPrimaryMarketHistory90d: boolean;
    runLinkedCandidateGroups: number;
    confirmedDirectCompetitors: number;
  }>;
  redirectPath?: string;
  redirectLocation?: string;
}

async function startApi(options: ApiOptions = {}): Promise<{
  baseUrl: string;
  requests: string[];
}> {
  const requests: string[] = [];
  let jobCount = 0;
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = `${request.method ?? 'GET'} ${url.pathname}${url.search}`;
    requests.push(route);
    const body = await readBody(request);
    if (url.pathname === options.redirectPath) {
      response.writeHead(302, { location: options.redirectLocation ?? 'https://private.invalid/' });
      response.end();
      return;
    }
    if (url.pathname === options.failPath) {
      respond(response, 502, options.failureBody ?? { error: SECRET_CANARY });
      return;
    }
    if (route === 'GET /api/settings') {
      respondData(response, {
        mode: 'live', role: 'admin', marketplace: 'US', defaultMarketId: 'market-1',
        currency: 'USD', timezone: 'UTC', aiModel: 'rule-engine-v1',
        refreshFrequency: 'manual', lastSuccessfulSync: null,
        debug: SECRET_CANARY,
      });
      return;
    }
    if (route === 'GET /api/markets') {
      respondData(response, [
        {
          id: 'market-1', name: PRIVATE_CANARY, parentId: null, level: 1,
          marketplace: 'US', categoryId: '100:200', sellerSpriteNodePath: '100:200',
          keywords: [], status: '等待30D对照', children: [],
        },
        {
          id: 'archived-unmapped', name: PRIVATE_CANARY, parentId: null, level: 1,
          marketplace: 'US', keywords: [], status: 'inactive', children: [],
        },
      ]);
      return;
    }
    if (route === 'POST /api/integrations/sellersprite/test') {
      respondData(response, {
        connected: true, authenticated: true, toolCount: 9,
        requiredCapabilityCount: 5, availableRequiredCapabilityCount: 5,
        missingCapabilities: [], latencyMs: 8, debug: SECRET_CANARY,
      });
      return;
    }
    if (route === `GET /api/integrations/sellersprite/capabilities?runId=${RUN_ID}`) {
      respondData(response, {
        collectedAt: '2026-09-21T00:00:00.000Z', toolCount: 9,
        required: HASHES.map((schemaHash, index) => ({
          capability: `CAPABILITY_${index}_${SECRET_CANARY}`,
          available: true,
          schemaHash,
          inputSchema: { secret: SECRET_CANARY },
        })),
      });
      return;
    }
    if (route === 'POST /api/integrations/sellersprite/sync/critical') {
      respondData(response, {
        runId: RUN_ID, taskId: RUN_ID, marketSnapshots: 2, productSnapshots: 4,
        candidateCoverage: options.candidateCoverage
          ?? { status: 'success', total: 2, success: 2, failed: 0, candidates: 1 },
        competitorCoverage: options.competitorCoverage
          ?? { status: 'success', total: 1, success: 1, failed: 0 },
        private: PRIVATE_CANARY,
      }, 201);
      return;
    }
    if (route === 'POST /api/integrations/sellersprite/sync/plan') {
      respondData(response, {id:RUN_ID, estimatedRemoteCalls:23, maximumRemoteCalls:48,
        localReuse:0, projectedRemaining:477, blockers:[]});
      return;
    }
    if (route === `GET /api/integrations/sellersprite/sync/critical/${RUN_ID}/roster`) {
      respondData(response, {
        marketId: 'market-1',
        ownedProductIds: ['owned-1', 'owned-2'],
        private: PRIVATE_CANARY,
      });
      return;
    }
    if (route === 'POST /api/research-jobs') {
      jobCount += 1;
      const parsed = body as { entityId?: string };
      respondData(response, {
        id: `job-${jobCount}`, status: 'draft', isDemo: false, entityId: parsed.entityId,
        error: null, private: PRIVATE_CANARY,
      }, 201);
      return;
    }
    if (/^POST \/api\/research-jobs\/job-\d+\/run$/.test(route)) {
      respondData(response, { id: url.pathname.split('/')[3], status: 'monitoring', isDemo: false, error: null });
      return;
    }
    if (/^GET \/api\/research-jobs\/job-\d+\/evidence$/.test(route)) {
      const evidence: Array<{
        id: string; sourceType: string; syncRunId: string | null;
        source: string; claim: string;
      }> = [{
        id: `evidence-${url.pathname.split('/')[3]}`,
        sourceType: 'mcp', syncRunId: options.evidenceRunId ?? RUN_ID,
        source: PRIVATE_CANARY, claim: PRIVATE_CANARY,
      }];
      if (options.includeMockEvidence && route.includes('job-2/')) {
        evidence.push({
          id: 'mock-evidence', sourceType: 'mock', syncRunId: null,
          source: PRIVATE_CANARY, claim: PRIVATE_CANARY,
        });
      }
      respondData(response, evidence);
      return;
    }
    if (route === 'GET /api/dashboard/executive?range=30D') {
      respondData(response, {
        ownedSkuPerformance: (options.dashboardProductIds ?? ['demo-owned', 'owned-1', 'owned-2'])
          .map((id) => ({ id })),
        market: { id: 'market-1', name: PRIVATE_CANARY },
        debug: SECRET_CANARY,
      });
      return;
    }
    if (route === `GET /api/dashboard/executive/run-proof/${RUN_ID}`) {
      respondData(response, options.dashboardProof ?? {
        passed: true, marketVerified: true, verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
      });
      return;
    }
    if (route === 'GET /api/go-live/verify') {
      respondData(response, {
        sellerSpriteCriticalRunId: RUN_ID,
        verifiedEvidenceEntities: 3,
        requiredEvidenceEntities: 3,
        readyForDemoCleanup: true,
        hasMinimumRealCoverage: false,
        primaryMarketHistoryDays: 92,
        hasPrimaryMarketHistory90d: true,
        runLinkedCandidateGroups: 1,
        confirmedDirectCompetitors: 1,
        ...options.verification,
        private: PRIVATE_CANARY,
      });
      return;
    }
    respond(response, 404, { error: `unexpected ${route}` });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function respondData(response: ServerResponse, data: unknown, status = 200): void {
  respond(response, status, { data, meta: { mode: 'live', generatedAt: '2026-09-21T00:00:00.000Z' } });
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function allStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStringValues);
  return [];
}
