import { describe, expect, it } from 'vitest';
import {
  SellerSpriteMcpClient,
  SellerSpriteMcpError,
  sellerSpriteEndpoint,
  sanitizeMcpError,
  type SellerSpriteMcpTransport,
} from './sellersprite-mcp-client.js';
import type {
  McpCacheEntry,
  McpCallLedgerEntry,
  McpCallLedgerStore,
  McpResponseCacheStore,
} from './sellersprite-mcp-store.js';
import {
  SqliteMcpCallLedgerStore,
  SqliteMcpCapabilityStore,
  SqliteMcpResponseCacheStore,
} from './sellersprite-mcp-store.js';
import { openDatabase } from '../database/database.js';

const fiveTools = [
  tool('market_research', 'Research Amazon markets', ['marketplace', 'keyword']),
  tool('market_statistics', 'Market sales statistics', ['marketplace', 'keyword']),
  tool('product_concentration', 'Product and brand concentration', ['marketplace', 'keyword']),
  tool('asin_sales_trend', 'Historical sales trend for an ASIN', ['marketplace', 'asin']),
  tool('asin_competitor_discovery', 'Discover competing ASINs', ['marketplace', 'asin']),
];

describe('SellerSpriteMcpClient', () => {
  it('records fresh tool discovery against the current critical run', async () => {
    const ledger = new MemoryLedgerStore();
    const runId = '123e4567-e89b-42d3-a456-426614174000';
    const client = new SellerSpriteMcpClient({
      transport: new FakeTransport({ pages: [listResult(fiveTools)] }),
      ledgerStore: ledger,
    });

    await client.listTools({ fresh: true, runId });

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      capability: 'LIST_TOOLS',
      operation: 'tool_discovery',
      status: 'success',
      cacheHit: false,
      runId,
      resultCount: fiveTools.length,
    });
  });

  it('records the current critical run on both remote and cached attempts', async () => {
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174000';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new FakeTransport({
        callOutcomes: [callResult({ code: 'OK', data: { products: 100 } })],
      });
      const client = new SellerSpriteMcpClient({
        transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      });
      const request = {
        tool: 'market_research_statistics',
        arguments: { request: { marketplace: 'US', nodeIdPath: '1055398:1063252' } },
        context: { capability: 'MARKET_STATISTICS', runId, observationMonth: '202609' },
      };

      await client.callTool(request);
      await client.callTool(request);

      expect(transport.callCount).toBe(1);
      expect(database.prepare(`SELECT sync_run_id, cache_hit, status, observation_month
        FROM mcp_call_logs ORDER BY rowid`).all())
        .toEqual([
          { sync_run_id: runId, cache_hit: 0, status: 'success', observation_month: '202609' },
          { sync_run_id: runId, cache_hit: 1, status: 'success', observation_month: '202609' },
        ]);
    } finally { database.close(); }
  });

  it('persists sanitized capabilities, attempts, and cache entries in the migrated SQLite schema', async () => {
    const database = openDatabase(':memory:');
    try {
      const capabilityStore = new SqliteMcpCapabilityStore(database);
      const ledgerStore = new SqliteMcpCallLedgerStore(database);
      const cacheStore = new SqliteMcpResponseCacheStore(database);
      const transport = new FakeTransport({
        callOutcomes: [callResult({ code: 'OK', data: {
          total: 42,
          auth: 'pin-123',
          authHeader: 'opaque-header-987',
          authenticationHeader: 'opaque-header-654',
          note: 'Bearer opaque-bearer-321',
          session: 'sess-456',
          cookie: 'cookie-789',
          credential: { value: 'credential-012' },
          clientSecret: 'client-345',
        } })],
      });
      capabilityStore.save({
        id: 'discovery-1', provider: 'sellersprite', discoveredAt: '2026-09-19T00:00:00.000Z',
        tools: [{ name: 'market_research_statistics', description: 'Market statistics',
          inputSchema: { type: 'object', required: ['request'] } }],
        capabilities: { MARKET_STATISTICS: 'market_research_statistics' },
        missingCapabilities: ['ASIN_SALES_TREND'],
      });
      const client = new SellerSpriteMcpClient({ transport, ledgerStore, cacheStore });
      const request = {
        tool: 'market_research_statistics',
        arguments: { request: { marketplace: 'US', nodeIdPath: 'Home/Bed' } },
        context: { capability: 'MARKET_STATISTICS', operation: 'market_refresh',
          entityType: 'market' as const, entityId: '1055398:1063252' },
      };
      await client.callTool(request);
      await client.callTool(request);

      expect(capabilityStore.latest()).toMatchObject({
        capabilities: { MARKET_STATISTICS: 'market_research_statistics' },
      });
      const rows = database.prepare(`SELECT status, cache_hit, actual_tool, request_hash,
        response_metadata_json, entity_type, entity_id, result_count
        FROM mcp_call_logs ORDER BY rowid`).all();
      expect(rows).toMatchObject([
        { status: 'success', cache_hit: 0, actual_tool: 'market_research_statistics',
          entity_type: 'market', entity_id: '1055398:1063252', result_count: 1 },
        { status: 'success', cache_hit: 1, actual_tool: 'market_research_statistics',
          entity_type: 'market', entity_id: '1055398:1063252', result_count: 1 },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/Home\/Bed|Authorization|secret-value/i);
      const cached = database.prepare('SELECT cache_key, response_json FROM mcp_response_cache').get();
      expect(cached).toMatchObject({ cache_key: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(cached)).not.toContain('Home/Bed');
      expect(JSON.stringify(cached)).not.toMatch(
        /pin-123|opaque-header-987|opaque-header-654|opaque-bearer-321|sess-456|cookie-789|credential-012|client-345/,
      );
    } finally { database.close(); }
  });

  it('collects every paginated tool before reporting an authenticated connection', async () => {
    const transport = new FakeTransport({
      pages: [
        listResult(fiveTools.slice(0, 2), 'page-2'),
        listResult(fiveTools.slice(2)),
        listResult(fiveTools.slice(0, 2), 'page-2'),
        listResult(fiveTools.slice(2)),
      ],
    });
    const client = new SellerSpriteMcpClient({ transport });

    const tools = await client.listTools();
    const diagnostic = await client.connectionTest();

    expect(tools.map((entry) => entry.name)).toEqual(fiveTools.map((entry) => entry.name));
    expect(diagnostic).toMatchObject({ connected: true, authenticated: true, toolCount: 5 });
    expect(transport.listCursors).toEqual([undefined, 'page-2', undefined, 'page-2']);
  });

  it('bypasses the in-memory tool catalog during connection certification', async () => {
    const transport = new FakeTransport({
      listOutcomes: [
        listResult(fiveTools),
        listResult(fiveTools.slice(0, 4)),
      ],
    });
    const client = new SellerSpriteMcpClient({ transport });
    await client.listTools();

    const diagnostic = await client.connectionTest();

    expect(diagnostic).toMatchObject({ connected: true, authenticated: true, toolCount: 4 });
    expect(transport.listCursors).toEqual([undefined, undefined]);
  });

  it('retries transient tool discovery failures with the same bounded backoff', async () => {
    const delays: number[] = [];
    const transport = new FakeTransport({
      listOutcomes: [httpError(429, 'rate limited'), listResult(fiveTools)],
    });
    const client = new SellerSpriteMcpClient({
      transport,
      retry: { maxAttempts: 3, baseDelayMs: 5 },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    const tools = await client.listTools();

    expect(tools).toHaveLength(5);
    expect(delays).toEqual([5]);
  });

  it('closes a transport even when connection setup failed', async () => {
    const transport = new FakeTransport({ connectOutcome: httpError(500, 'unavailable') });
    const client = new SellerSpriteMcpClient({ transport, retry: { maxAttempts: 1, baseDelayMs: 1 } });

    await client.listTools().catch(() => undefined);
    await client.close();

    expect(transport.closeCount).toBe(1);
  });

  it('retries rate limits with bounded exponential backoff and records every remote attempt', async () => {
    const ledger = new MemoryLedgerStore();
    const delays: number[] = [];
    const transport = new FakeTransport({
      callOutcomes: [
        httpError(429, 'rate limited at https://mcp.example.test?secretKey=secret-value'),
        httpError(429, 'retry token=secret-value'),
        callResult({ rows: [{ asin: 'B000TEST01', sales: 120 }] }),
      ],
    });
    const client = new SellerSpriteMcpClient({
      transport,
      ledgerStore: ledger,
      cacheTtlMs: 0,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    const result = await client.callTool({
      tool: 'asin_sales_trend',
      arguments: { marketplace: 'US', asin: 'B000TEST01' },
      context: { capability: 'ASIN_SALES_TREND', operation: 'owned_sku_refresh' },
    });

    expect(result.structuredContent).toEqual({ rows: [{ asin: 'B000TEST01', sales: 120 }] });
    expect(delays).toEqual([10, 20]);
    expect(ledger.entries.map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([
      { status: 'failed', errorCode: 'RATE_LIMIT' },
      { status: 'failed', errorCode: 'RATE_LIMIT' },
      { status: 'success', errorCode: null },
    ]);
    expect(JSON.stringify(ledger.entries)).not.toMatch(/secret-value|Authorization/i);
  });

  it('aborts timed-out calls and returns a typed timeout after the configured bound', async () => {
    const ledger = new MemoryLedgerStore();
    const transport = new FakeTransport({ hangCallsUntilAbort: true });
    const client = new SellerSpriteMcpClient({
      transport,
      ledgerStore: ledger,
      cacheTtlMs: 0,
      timeoutMs: 5,
      retry: { maxAttempts: 1, baseDelayMs: 1 },
    });

    const failure = await client.callTool({
      tool: 'market_statistics',
      arguments: { marketplace: 'US', keyword: 'memory foam pillow' },
      context: { capability: 'MARKET_STATISTICS' },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SellerSpriteMcpError);
    expect(failure).toMatchObject({ code: 'TIMEOUT' });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT', cacheHit: false });
  });

  it('uses a valid cached response and records the cache hit without another remote call', async () => {
    const ledger = new MemoryLedgerStore();
    const cache = new MemoryCacheStore();
    let now = 1_000;
    const transport = new FakeTransport({
      callOutcomes: [callResult({ total: 42 })],
    });
    const client = new SellerSpriteMcpClient({
      transport,
      ledgerStore: ledger,
      cacheStore: cache,
      cacheTtlMs: 10_000,
      now: () => now,
    });

    const request = {
      tool: 'market_statistics',
      arguments: { keyword: 'memory foam pillow', marketplace: 'US' },
      context: { capability: 'MARKET_STATISTICS' },
    } as const;
    const first = await client.callTool(request);
    now += 500;
    const second = await client.callTool(request);

    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(transport.callCount).toBe(1);
    expect(ledger.entries.at(-1)).toMatchObject({
      provider: 'sellersprite', status: 'success', cacheHit: true,
    });
    expect(cache.entries[0].cacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(cache.entries)).not.toContain('memory foam pillow');
  });

  it('waits for token-bucket capacity before a second uncached remote call', async () => {
    let now = 0;
    const waits: number[] = [];
    const transport = new FakeTransport({
      callOutcomes: [callResult({ n: 1 }), callResult({ n: 2 })],
    });
    const client = new SellerSpriteMcpClient({
      transport,
      cacheTtlMs: 0,
      rateLimit: { capacity: 1, refillPerSecond: 1 },
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    await client.callTool({ tool: 'one', arguments: {}, context: {} });
    await client.callTool({ tool: 'two', arguments: {}, context: {} });

    expect(waits).toEqual([1_000]);
    expect(transport.callCount).toBe(2);
  });

  it('maps auth, missing-tool, malformed-response, and remote failures to stable codes', async () => {
    const cases = [
      { outcome: httpError(401, 'Authorization: Bearer secret-value'), code: 'AUTH_ERROR' },
      { outcome: httpError(404, 'unknown tool secret=secret-value'), code: 'TOOL_NOT_FOUND' },
      { outcome: { content: [{ type: 'text', text: 7 }] }, code: 'INVALID_SCHEMA' },
      { outcome: httpError(500, 'upstream token secret-value'), code: 'REMOTE_ERROR' },
    ] as const;

    for (const testCase of cases) {
      const client = new SellerSpriteMcpClient({
        transport: new FakeTransport({ callOutcomes: [testCase.outcome] }),
        cacheTtlMs: 0,
        retry: { maxAttempts: 1, baseDelayMs: 1 },
      });
      const failure = await client.callTool({ tool: 'test', arguments: {}, context: {} })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: testCase.code });
      expect(String(failure)).not.toMatch(/secret-value|Authorization/i);
    }
  });

  it('does not cache a provider-rejected envelope or record it as success', async () => {
    const ledger = new MemoryLedgerStore();
    const cache = new MemoryCacheStore();
    const client = new SellerSpriteMcpClient({
      transport: new FakeTransport({ callOutcomes: [callResult({ code: 'DENIED', data: null })] }),
      ledgerStore: ledger,
      cacheStore: cache,
      retry: { maxAttempts: 1, baseDelayMs: 1 },
    });

    await expect(client.callTool({ tool: 'asin_sales_trend', arguments: { asin: 'B000TEST01' }, context: {} }))
      .rejects.toMatchObject({ code: 'REMOTE_ERROR' });
    expect(ledger.entries).toMatchObject([{ status: 'failed', errorCode: 'REMOTE_ERROR' }]);
    expect(cache.entries).toHaveLength(0);
  });

  it('redacts query credentials, authorization, tokens, and secret-key values', () => {
    const secretBearingError = new Error(
      'Authorization: Bearer secret-value; https://example.test/mcp?token=secret-value&x=1 '
      + '{"secretKey":"secret-value","api_key":"secret-value","auth":"opaque-pin"} '
      + 'secret-key=secret-value session=opaque-session credential=opaque-credential',
    );

    const diagnostic = sanitizeMcpError(secretBearingError);

    expect(diagnostic).not.toMatch(/secret-value|Authorization|opaque-pin|opaque-session|opaque-credential/i);
    expect(diagnostic).toContain('[REDACTED]');
  });

  it('uses only the separate SellerSprite secret and rejects credentials embedded in the URL', () => {
    const endpoint = sellerSpriteEndpoint('https://mcp.sellersprite.com/mcp', 'test-secret');
    expect(endpoint.searchParams.get('secret-key')).toBe('test-secret');
    expect(endpoint.searchParams.has('secretKey')).toBe(false);
    expect(() => sellerSpriteEndpoint('https://mcp.sellersprite.com/mcp?secretKey=old', 'test-secret'))
      .toThrow(/URL.*凭据|credential/i);
    expect(() => sellerSpriteEndpoint('https://mcp.sellersprite.com/mcp?secret-key=old'))
      .toThrow(/URL.*凭据|credential/i);
    for (const key of ['auth', 'x-auth', 'authHeader', 'authenticationHeader',
      'credential', 'session', 'cookie', 'access_key']) {
      expect(() => sellerSpriteEndpoint(`https://mcp.sellersprite.com/mcp?${key}=old`))
        .toThrow(/URL.*凭据|credential/i);
    }
    expect(() => sellerSpriteEndpoint('https://user:password@mcp.sellersprite.com/mcp', 'test-secret'))
      .toThrow(/URL.*凭据|credential/i);
  });

  it('rejects a secret-bearing remote HTTP endpoint without exposing the secret', () => {
    expect(() => sellerSpriteEndpoint('http://mcp.sellersprite.com/mcp', 'test-secret'))
      .toThrow(/HTTPS|安全连接/i);
    try {
      sellerSpriteEndpoint('http://mcp.sellersprite.com/mcp', 'test-secret');
    } catch (error) {
      expect(String(error)).not.toContain('test-secret');
    }
  });

  it.each(['http://localhost:8787/mcp', 'http://127.0.0.1:8787/mcp', 'http://[::1]:8787/mcp'])(
    'permits a secret-bearing loopback endpoint at %s', (address) => {
      expect(sellerSpriteEndpoint(address, 'test-secret').searchParams.get('secret-key'))
        .toBe('test-secret');
    },
  );
});

function tool(name: string, description: string, required: string[]) {
  return {
    name,
    title: name.replaceAll('_', ' '),
    description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])),
      required,
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object' as const,
      properties: { rows: { type: 'array', items: { type: 'object' } } },
    },
    annotations: {
      title: description,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execution: { taskSupport: 'forbidden' as const },
    icons: [{ src: 'https://example.test/icon.png', mimeType: 'image/png', sizes: ['32x32'] }],
    _meta: { provider: 'sellersprite' },
  };
}

function listResult(tools: ReturnType<typeof tool>[], nextCursor?: string) {
  return {
    tools,
    nextCursor,
    _meta: {
      progressToken: 'test-progress',
      'io.modelcontextprotocol/related-task': { taskId: 'test-task' },
    },
  };
}

function callResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(structuredContent),
      annotations: { audience: ['assistant' as const], priority: 1, lastModified: '2026-09-19T00:00:00.000Z' },
      _meta: { format: 'json' },
    }],
    structuredContent,
    isError: false,
    _meta: {
      progressToken: 'test-progress',
      'io.modelcontextprotocol/related-task': { taskId: 'test-task' },
    },
  };
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

class FakeTransport implements SellerSpriteMcpTransport {
  readonly listCursors: Array<string | undefined> = [];
  callCount = 0;
  closeCount = 0;
  private pageIndex = 0;
  private outcomeIndex = 0;

  constructor(private readonly options: {
    pages?: Array<ReturnType<typeof listResult>>;
    listOutcomes?: unknown[];
    callOutcomes?: unknown[];
    hangCallsUntilAbort?: boolean;
    connectOutcome?: Error;
  }) {}

  async connect(): Promise<void> {
    if (this.options.connectOutcome) throw this.options.connectOutcome;
  }
  async ping(): Promise<Record<string, unknown>> { return { _meta: { progressToken: 'ping' } }; }

  async listTools(
    params: { cursor?: string },
    options: { signal: AbortSignal },
  ): Promise<unknown> {
    void options;
    this.listCursors.push(params.cursor);
    const outcome = this.options.listOutcomes?.[this.pageIndex++];
    if (outcome instanceof Error) throw outcome;
    if (outcome) return outcome;
    return this.options.pages?.[this.pageIndex++] ?? listResult([]);
  }

  async callTool(
    _params: { name: string; arguments: Record<string, unknown> },
    options: { signal: AbortSignal },
  ): Promise<unknown> {
    this.callCount += 1;
    if (this.options.hangCallsUntilAbort) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    const outcome = this.options.callOutcomes?.[this.outcomeIndex++];
    if (outcome instanceof Error) throw outcome;
    return outcome ?? callResult({ ok: true });
  }

  async close(): Promise<void> { this.closeCount += 1; }
}

class MemoryLedgerStore implements McpCallLedgerStore {
  readonly entries: McpCallLedgerEntry[] = [];
  record(entry: McpCallLedgerEntry): void { this.entries.push(entry); }
}

class MemoryCacheStore implements McpResponseCacheStore {
  readonly entries: McpCacheEntry[] = [];
  get(cacheKey: string, now: string): McpCacheEntry | null {
    return this.entries.find((entry) => entry.cacheKey === cacheKey && entry.expiresAt > now) ?? null;
  }
  set(entry: McpCacheEntry): void {
    this.entries.splice(0, this.entries.length, entry);
  }
}
