import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 7_200_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const settingsSchema = z.object({
  role: z.literal('admin'),
  marketplace: z.string().min(1),
  defaultMarketId: z.string().min(1),
});
const marketSchema = z.object({
  id: z.string().min(1),
  marketplace: z.string().min(1),
  categoryId: z.string().optional(),
  sellerSpriteNodePath: z.string().optional(),
  status: z.string(),
});
const connectionSchema = z.object({
  connected: z.boolean(),
  authenticated: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  requiredCapabilityCount: z.number().int().positive(),
  availableRequiredCapabilityCount: z.number().int().nonnegative(),
  missingCapabilities: z.array(z.unknown()),
});
const capabilitiesSchema = z.object({
  toolCount: z.number().int().nonnegative(),
  required: z.array(z.object({
    available: z.boolean(),
    schemaHash: z.string().regex(HASH_PATTERN).nullable(),
  })).min(1),
});
const secondaryCoverageSchema = z.object({
  status: z.enum(['success', 'partial', 'failed']),
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
}).refine((coverage) => coverage.success + coverage.failed === coverage.total
  && coverage.status === (coverage.failed === 0 ? 'success'
    : coverage.success === 0 ? 'failed' : 'partial'));
const criticalRunSchema = z.object({
  runId: z.string().uuid(),
  marketSnapshots: z.number().int().nonnegative(),
  productSnapshots: z.number().int().nonnegative(),
  candidateCoverage: secondaryCoverageSchema.extend({
    candidates: z.number().int().nonnegative(),
  }),
  competitorCoverage: secondaryCoverageSchema,
});
const runRosterSchema = z.object({
  marketId: z.string().min(1),
  ownedProductIds: z.array(z.string().min(1)).min(1),
});
const jobSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  isDemo: z.boolean(),
  error: z.string().nullable().optional(),
});
const evidenceSchema = z.array(z.object({
  sourceType: z.string(),
  syncRunId: z.string().nullable().optional(),
}));
const dashboardSchema = z.object({
  market: z.object({ id: z.string().min(1) }).nullable(),
  ownedSkuPerformance: z.array(z.object({ id: z.string().min(1) })),
});
const dashboardProofSchema = z.object({
  passed: z.boolean(),
  marketVerified: z.boolean(),
  verifiedOwnedProducts: z.number().int().nonnegative(),
  requiredOwnedProducts: z.number().int().nonnegative(),
});
const verificationSchema = z.object({
  sellerSpriteCriticalRunId: z.string().uuid().nullable(),
  verifiedEvidenceEntities: z.number().int().nonnegative(),
  requiredEvidenceEntities: z.number().int().nonnegative(),
  primaryMarketHistoryDays: z.number().int().nonnegative(),
  hasPrimaryMarketHistory90d: z.boolean(),
  runLinkedCandidateGroups: z.number().int().nonnegative(),
  confirmedDirectCompetitors: z.number().int().nonnegative(),
  readyForDemoCleanup: z.boolean(),
  hasMinimumRealCoverage: z.boolean(),
});

export interface AcceptanceCliDependencies {
  fetchImpl: typeof fetch;
  writeOutput: (value: string) => void;
}

interface AcceptanceArguments {
  baseUrl: URL;
  month: string;
  timeoutMs: number;
}

interface AcceptanceSummary {
  ok: boolean;
  acceptanceScope: 'critical_market_and_owned_skus';
  manualCompetitorReview: 'not_checked' | 'confirmed' | 'missing';
  checks: {
    preflight: boolean;
    connection: boolean;
    schemas: boolean;
    criticalSync: boolean;
    secondaryCoverage: boolean;
    workflows: boolean;
    evidence: boolean;
    dashboard: boolean;
    verification: boolean;
  };
  counts: {
    tools: number;
    requiredCapabilities: number;
    schemaHashes: number;
    ownedProducts: number;
    candidateDiscoveryProducts: number;
    candidateDiscoveryFailures: number;
    competitorCandidates: number;
    directCompetitors: number;
    refreshedDirectCompetitors: number;
    failedDirectCompetitors: number;
    primaryMarketHistoryDays: number;
    runLinkedCandidateGroups: number;
    confirmedDirectCompetitors: number;
    marketSnapshots: number;
    productSnapshots: number;
    jobs: number;
    evidence: number;
    dashboardOwnedProducts: number;
    verifiedDashboardOwnedProducts: number;
    verifiedEvidenceEntities: number;
    requiredEvidenceEntities: number;
  };
  runId?: string;
  schemaHashes: string[];
}

export async function runAcceptanceCli(
  args: string[],
  dependencies: Partial<AcceptanceCliDependencies> = {},
): Promise<number> {
  const writeOutput = dependencies.writeOutput ?? ((value: string) => { process.stdout.write(value); });
  const summary = emptySummary();
  try {
    const parsed = parseArguments(args);
    const request = createApiClient(
      parsed.baseUrl,
      parsed.timeoutMs,
      dependencies.fetchImpl ?? globalThis.fetch,
    );
    const settings = settingsSchema.parse(await request('/api/settings'));
    const markets = z.array(marketSchema).parse(await request('/api/markets'));
    const market = markets.find((item) => item.id === settings.defaultMarketId);
    requireCondition(market?.marketplace === settings.marketplace
      && typeof market.sellerSpriteNodePath === 'string'
      && /^\d+(?::\d+)*$/.test(market.sellerSpriteNodePath));
    summary.checks.preflight = true;

    const connection = connectionSchema.parse(await request(
      '/api/integrations/sellersprite/test', { method: 'POST', body: '{}' },
    ));
    requireCondition(connection.connected && connection.authenticated
      && connection.availableRequiredCapabilityCount === connection.requiredCapabilityCount
      && connection.missingCapabilities.length === 0);
    summary.counts.tools = connection.toolCount;
    summary.counts.requiredCapabilities = connection.requiredCapabilityCount;
    summary.checks.connection = true;

    const critical = criticalRunSchema.parse(await request(
      '/api/integrations/sellersprite/sync/critical',
      { method: 'POST', body: JSON.stringify({ marketId: settings.defaultMarketId, month: parsed.month }) },
    ));
    summary.runId = critical.runId;
    summary.counts.marketSnapshots = critical.marketSnapshots;
    summary.counts.productSnapshots = critical.productSnapshots;
    summary.checks.criticalSync = true;
    const candidate = critical.candidateCoverage;
    const competitor = critical.competitorCoverage;
    summary.counts.candidateDiscoveryProducts = candidate.success;
    summary.counts.candidateDiscoveryFailures = candidate.failed;
    summary.counts.competitorCandidates = candidate.candidates;
    summary.counts.directCompetitors = competitor.total;
    summary.counts.refreshedDirectCompetitors = competitor.success;
    summary.counts.failedDirectCompetitors = competitor.failed;

    const roster = runRosterSchema.parse(await request(
      `/api/integrations/sellersprite/sync/critical/${encodeURIComponent(critical.runId)}/roster`,
    ));
    requireCondition(roster.marketId === settings.defaultMarketId
      && new Set(roster.ownedProductIds).size === roster.ownedProductIds.length);
    summary.counts.ownedProducts = roster.ownedProductIds.length;
    requireCondition(candidate.status === 'success'
      && candidate.total === roster.ownedProductIds.length
      && candidate.success === candidate.total && candidate.failed === 0
      && candidate.candidates > 0
      && competitor.total > 0 && competitor.success > 0);
    summary.checks.secondaryCoverage = true;

    const capabilities = capabilitiesSchema.parse(await request(
      `/api/integrations/sellersprite/capabilities?runId=${encodeURIComponent(critical.runId)}`,
    ));
    const hashes = capabilities.required.map((item) => item.schemaHash);
    requireCondition(capabilities.required.length === connection.requiredCapabilityCount
      && capabilities.required.every((item) => item.available)
      && hashes.every((hash): hash is string => hash !== null));
    summary.schemaHashes = hashes.slice().sort();
    summary.counts.schemaHashes = hashes.length;
    summary.checks.schemas = true;

    const dashboard = dashboardSchema.parse(await request('/api/dashboard/executive?range=30D'));
    const dashboardCounts = new Map<string, number>();
    for (const item of dashboard.ownedSkuPerformance) {
      dashboardCounts.set(item.id, (dashboardCounts.get(item.id) ?? 0) + 1);
    }
    requireCondition(dashboard.market?.id === settings.defaultMarketId
      && roster.ownedProductIds.every((id) => dashboardCounts.get(id) === 1));
    const dashboardProof = dashboardProofSchema.parse(await request(
      `/api/dashboard/executive/run-proof/${encodeURIComponent(critical.runId)}`,
    ));
    requireCondition(dashboardProof.passed && dashboardProof.marketVerified
      && dashboardProof.requiredOwnedProducts === roster.ownedProductIds.length
      && dashboardProof.verifiedOwnedProducts === roster.ownedProductIds.length);
    summary.counts.dashboardOwnedProducts = dashboard.ownedSkuPerformance.length;
    summary.counts.verifiedDashboardOwnedProducts = roster.ownedProductIds.length;
    summary.checks.dashboard = true;

    const jobs: string[] = [];
    jobs.push(await createAndRunJob(request, {
      name: `Real acceptance market ${critical.runId}`,
      type: 'existing_market',
      marketplace: settings.marketplace,
      entityType: 'market_node',
      entityId: roster.marketId,
      input: {},
      taskBook: {},
      createdBy: 'real-acceptance-runner',
    }));
    for (const [index, productId] of roster.ownedProductIds.entries()) {
      jobs.push(await createAndRunJob(request, {
        name: `Real acceptance owned product ${index + 1} ${critical.runId}`,
        type: 'owned_product',
        marketplace: settings.marketplace,
        entityType: 'owned_product',
        entityId: productId,
        input: {},
        taskBook: {},
        createdBy: 'real-acceptance-runner',
      }));
    }
    summary.counts.jobs = jobs.length;
    summary.checks.workflows = true;

    for (const jobId of jobs) {
      const evidence = evidenceSchema.parse(await request(
        `/api/research-jobs/${encodeURIComponent(jobId)}/evidence`,
      ));
      requireCondition(evidence.every((item) => item.sourceType !== 'mock'));
      const exactRunEvidence = evidence.filter((item) => (
        item.sourceType === 'mcp' && item.syncRunId === critical.runId
      ));
      requireCondition(exactRunEvidence.length > 0);
      summary.counts.evidence += exactRunEvidence.length;
    }
    summary.checks.evidence = true;

    const verification = verificationSchema.parse(await request('/api/go-live/verify'));
    summary.counts.primaryMarketHistoryDays = verification.primaryMarketHistoryDays;
    summary.counts.runLinkedCandidateGroups = verification.runLinkedCandidateGroups;
    summary.counts.confirmedDirectCompetitors = verification.confirmedDirectCompetitors;
    summary.manualCompetitorReview = verification.confirmedDirectCompetitors > 0
      ? 'confirmed' : 'missing';
    requireCondition(verification.sellerSpriteCriticalRunId === critical.runId
      && verification.readyForDemoCleanup
      && verification.hasPrimaryMarketHistory90d
      && verification.primaryMarketHistoryDays >= 90
      && verification.runLinkedCandidateGroups > 0
      && verification.confirmedDirectCompetitors > 0
      && verification.verifiedEvidenceEntities === jobs.length
      && verification.requiredEvidenceEntities === jobs.length);
    summary.counts.verifiedEvidenceEntities = verification.verifiedEvidenceEntities;
    summary.counts.requiredEvidenceEntities = verification.requiredEvidenceEntities;
    summary.checks.verification = true;
    summary.ok = true;
  } catch {
    summary.ok = false;
  }
  writeOutput(`${JSON.stringify(summary)}\n`);
  return summary.ok ? 0 : 1;
}

async function createAndRunJob(
  request: ReturnType<typeof createApiClient>,
  body: Record<string, unknown>,
): Promise<string> {
  const created = jobSchema.parse(await request('/api/research-jobs', {
    method: 'POST', body: JSON.stringify(body),
  }));
  requireCondition(!created.isDemo && created.status === 'draft' && !created.error);
  const completed = jobSchema.parse(await request(
    `/api/research-jobs/${encodeURIComponent(created.id)}/run`,
    { method: 'POST', body: '{}' },
  ));
  requireCondition(completed.id === created.id && !completed.isDemo
    && completed.status === 'monitoring' && !completed.error);
  return created.id;
}

function createApiClient(baseUrl: URL, timeoutMs: number, fetchImpl: typeof fetch) {
  return async (path: string, init: RequestInit = {}): Promise<unknown> => {
    if (!isAllowedAcceptanceRequest(init.method ?? 'GET', path)) {
      throw new Error('Acceptance route is not allowed');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        ...init,
        headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Acceptance API request failed');
      }
      const envelope = z.object({ data: z.unknown() }).parse(await response.json());
      return envelope.data;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function isAllowedAcceptanceRequest(method: string, path: string): boolean {
  const route = method === 'GET' ? [
    /^\/api\/(?:settings|markets|go-live\/verify)$/,
    /^\/api\/integrations\/sellersprite\/capabilities\?runId=[0-9a-fA-F-]{36}$/,
    /^\/api\/integrations\/sellersprite\/sync\/critical\/[0-9a-fA-F-]{36}\/roster$/,
    /^\/api\/dashboard\/executive\?range=30D$/,
    /^\/api\/dashboard\/executive\/run-proof\/[0-9a-fA-F-]{36}$/,
    /^\/api\/research-jobs\/[A-Za-z0-9_-]+\/evidence$/,
  ] : method === 'POST' ? [
    /^\/api\/integrations\/sellersprite\/(?:test|sync\/critical)$/,
    /^\/api\/research-jobs$/,
    /^\/api\/research-jobs\/[A-Za-z0-9_-]+\/run$/,
  ] : [];
  return route.some((allowed) => allowed.test(path));
}

function parseArguments(args: string[]): AcceptanceArguments {
  let baseUrl = DEFAULT_BASE_URL;
  let month: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--base-url' && value) {
      baseUrl = value;
      index += 1;
    } else if (argument === '--month' && value) {
      month = value;
      index += 1;
    } else if (argument === '--timeout-ms' && value) {
      timeoutMs = Number(value);
      index += 1;
    } else {
      throw new Error('Invalid acceptance runner arguments');
    }
  }
  requireCondition(typeof month === 'string' && /^\d{6}$/.test(month));
  const monthNumber = Number(month.slice(4));
  requireCondition(monthNumber >= 1 && monthNumber <= 12);
  requireCondition(Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 14_400_000);
  const parsedBaseUrl = new URL(baseUrl);
  requireCondition(['http:', 'https:'].includes(parsedBaseUrl.protocol));
  requireCondition(['127.0.0.1', 'localhost', '[::1]'].includes(parsedBaseUrl.hostname));
  requireCondition(!parsedBaseUrl.username && !parsedBaseUrl.password
    && !parsedBaseUrl.search && !parsedBaseUrl.hash && parsedBaseUrl.pathname === '/');
  return { baseUrl: parsedBaseUrl, month, timeoutMs };
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error('Acceptance check failed');
}

function emptySummary(): AcceptanceSummary {
  return {
    ok: false,
    acceptanceScope: 'critical_market_and_owned_skus',
    manualCompetitorReview: 'not_checked',
    checks: {
      preflight: false,
      connection: false,
      schemas: false,
      criticalSync: false,
      secondaryCoverage: false,
      workflows: false,
      evidence: false,
      dashboard: false,
      verification: false,
    },
    counts: {
      tools: 0,
      requiredCapabilities: 0,
      schemaHashes: 0,
      ownedProducts: 0,
      candidateDiscoveryProducts: 0,
      candidateDiscoveryFailures: 0,
      competitorCandidates: 0,
      directCompetitors: 0,
      refreshedDirectCompetitors: 0,
      failedDirectCompetitors: 0,
      primaryMarketHistoryDays: 0,
      runLinkedCandidateGroups: 0,
      confirmedDirectCompetitors: 0,
      marketSnapshots: 0,
      productSnapshots: 0,
      jobs: 0,
      evidence: 0,
      dashboardOwnedProducts: 0,
      verifiedDashboardOwnedProducts: 0,
      verifiedEvidenceEntities: 0,
      requiredEvidenceEntities: 0,
    },
    schemaHashes: [],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAcceptanceCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
