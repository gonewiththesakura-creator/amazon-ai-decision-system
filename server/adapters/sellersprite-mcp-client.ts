import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  mcpCallToolResultSchema,
  mcpListToolsResultSchema,
  mcpJsonPayload,
  type McpCallToolResult,
  type McpToolDefinition,
} from './sellersprite-mcp-schemas.js';
import {
  newLedgerEntry,
  type McpCallLedgerStore,
  type McpResponseCacheStore,
  type McpCallLedgerEntry,
} from './sellersprite-mcp-store.js';
import { isCredentialFieldName, redactCredentialAssignments } from './sensitive-field.js';
import { currentExecution, McpBudgetManager, McpPolicyError, RemoteRequestSingleflight, requestKey } from './mcp-policy.js';

export type SellerSpriteMcpErrorCode =
  | 'AUTH_ERROR' | 'RATE_LIMIT' | 'TIMEOUT' | 'TOOL_NOT_FOUND' | 'INVALID_SCHEMA' | 'REMOTE_ERROR';

export class SellerSpriteMcpError extends Error {
  constructor(readonly code: SellerSpriteMcpErrorCode, message: string) {
    super(message);
    this.name = 'SellerSpriteMcpError';
  }
}

export interface SellerSpriteMcpTransport {
  connect(options?: { signal: AbortSignal }): Promise<void>;
  ping(options?: { signal: AbortSignal }): Promise<unknown>;
  listTools(params: { cursor?: string }, options: { signal: AbortSignal }): Promise<unknown>;
  callTool(params: { name: string; arguments: Record<string, unknown> }, options: { signal: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
}

export interface SellerSpriteToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  context: { capability?: string; operation?: string;
    entityType?: 'market' | 'product' | 'competitor'; entityId?: string;
    researchJobId?: string; runId?: string; observationMonth?: string; fresh?: boolean;
    schemaHash?: string; cacheTtlMs?: number; secondary?: boolean };
}

export interface SellerSpriteMcpAcquisition {
  source: 'remote' | 'cache';
  acquiredAt: string;
}

export interface SellerSpriteValidated<T> {
  value: T;
  observationCertification?: McpCallLedgerEntry['observationCertification'];
}

interface SellerSpriteMcpClientOptions {
  budget?: McpBudgetManager;
  transport?: SellerSpriteMcpTransport;
  ledgerStore?: McpCallLedgerStore;
  cacheStore?: McpResponseCacheStore;
  timeoutMs?: number;
  cacheTtlMs?: number;
  retry?: { maxAttempts: number; baseDelayMs: number };
  rateLimit?: { capacity: number; refillPerSecond: number };
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function sanitizeMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactCredentialAssignments(message
    .replace(/https?:\/\/[^\s'"<>]+/gi, '[REDACTED]')
    .replace(/Authorization\s*[:=]\s*(?:Bearer\s+)?[^\s;,}]+/gi, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"';,}]+/gi, '[REDACTED]')
    .replace(/(?:secret[-_]?key|api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*["']?[^\s&,;}"']+["']?/gi, '[REDACTED]')
    .replace(/(["'])(?:secret[-_]?key|api[_-]?key|access[_-]?token|token|password|secret)\1\s*:\s*["'][^"']+["']/gi, '[REDACTED]'));
}

export function sellerSpriteEndpoint(configured: string, secret?: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(configured); }
  catch { throw new SellerSpriteMcpError('AUTH_ERROR', 'SellerSprite MCP endpoint is invalid'); }
  if (!['https:', 'http:'].includes(endpoint.protocol)) {
    throw new SellerSpriteMcpError('AUTH_ERROR', 'SellerSprite MCP endpoint protocol is invalid');
  }
  const loopbackHost = endpoint.hostname === 'localhost'
    || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '[::1]';
  if (secret && endpoint.protocol === 'http:' && !loopbackHost) {
    throw new SellerSpriteMcpError(
      'AUTH_ERROR',
      'SellerSprite MCP 密钥仅允许通过 HTTPS 或本机回环地址传输。',
    );
  }
  const credentialParameter = [...endpoint.searchParams.keys()].find(isCredentialFieldName);
  if (endpoint.username || endpoint.password || credentialParameter) {
    throw new SellerSpriteMcpError(
      'AUTH_ERROR',
      'SellerSprite MCP URL 不得包含凭据；请使用 SELLERSPRITE_MCP_SECRET。',
    );
  }
  return endpoint;
}

export class SellerSpriteMcpClient {
  private transport?: SellerSpriteMcpTransport;
  private connected = false;
  private catalog?: McpToolDefinition[];
  private catalogAt = 0;
  private readonly flights = new RemoteRequestSingleflight();
  private readonly requests = new RemoteRequestSingleflight();
  private connecting?: Promise<void>;
  private tokens: number;
  private lastRefill: number;
  private rateQueue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly rateLimit: { capacity: number; refillPerSecond: number };

  constructor(private readonly options: SellerSpriteMcpClientOptions = {}) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.rateLimit = options.rateLimit ?? { capacity: 4, refillPerSecond: 2 };
    this.tokens = this.rateLimit.capacity;
    this.lastRefill = this.now();
  }

  private async ensureTransport(): Promise<SellerSpriteMcpTransport> {
    if (!this.transport) {
      const configured = process.env.SELLERSPRITE_MCP_URL;
      if (!configured) throw new SellerSpriteMcpError('AUTH_ERROR', 'SellerSprite MCP is not configured');
      const endpoint = sellerSpriteEndpoint(configured, process.env.SELLERSPRITE_MCP_SECRET);
      const sdkClient = new Client({ name: 'amazon-ai-decision-system', version: '2.2.0' });
      const secret = process.env.SELLERSPRITE_MCP_SECRET;
      const sdkTransport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          ...(secret ? { headers: { 'secret-key': secret } } : {}),
          // Custom credential headers must never follow a provider redirect.
          redirect: 'error',
        },
      });
      this.transport = {
        connect: (requestOptions) => sdkClient.connect(sdkTransport, requestOptions),
        ping: (requestOptions) => sdkClient.ping(requestOptions),
        listTools: (params, requestOptions) => sdkClient.listTools(params, requestOptions),
        callTool: (params, requestOptions) => sdkClient.callTool(params, undefined, requestOptions),
        close: () => sdkClient.close(),
      };
    }
    if (!this.connected) {
      this.connecting ??= this.withTimeout((signal) => this.transport!.connect({ signal }));
      try { await this.connecting; } finally { this.connecting = undefined; }
      this.connected = true;
    }
    return this.transport;
  }

  async connectionTest(): Promise<{ connected: boolean; authenticated: boolean; toolCount: number; errorCode?: SellerSpriteMcpErrorCode }> {
    try {
      // Fresh discovery exercises initialization, authentication, and a real provider request.
      // MCP ping is optional and SellerSprite may reject or ignore it.
      const tools = await this.listTools({ fresh: true });
      return { connected: true, authenticated: true, toolCount: tools.length };
    } catch (error) {
      if (error instanceof McpPolicyError) throw error;
      const mapped = mapMcpError(error);
      return { connected: false, authenticated: mapped.code !== 'AUTH_ERROR', toolCount: 0, errorCode: mapped.code };
    }
  }

  async listTools(options: { fresh?: boolean; runId?: string } = {}): Promise<McpToolDefinition[]> {
    if (this.catalog && !options.fresh && this.now() - this.catalogAt < (this.options.budget?.ttl('LIST_TOOLS') ?? 7 * 86400_000)) {
      this.options.budget?.record('list_tools', 'cache_hit');
      return this.catalog;
    }
    return this.flights.run(`list:${options.fresh ? options.runId ?? 'manual' : 'incremental'}`, () => this.discoverTools(options));
  }

  private async discoverTools(options: { fresh?: boolean; runId?: string }): Promise<McpToolDefinition[]> {
    const startedAt = new Date(this.now()).toISOString();
    try {
      const transport = await this.ensureTransport();
      const tools: McpToolDefinition[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await this.runWithRetry(async () => {
          await this.acquireToken();
          this.options.budget?.beforeRemote('list_tools');
          try {
            const result = await this.withTimeout((signal) => transport.listTools({ cursor }, { signal }));
            if (!mcpListToolsResultSchema.safeParse(result).success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite MCP tool list');
            this.options.budget?.result();
            return result;
          } catch (error) { this.options.budget?.result(mapMcpError(error).code); throw error; }
        });
        const page = mcpListToolsResultSchema.safeParse(response);
        if (!page.success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite MCP tool list');
        tools.push(...page.data.tools);
        cursor = page.data.nextCursor;
        if (cursor && cursors.has(cursor)) {
          throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Repeated SellerSprite MCP page cursor');
        }
        if (cursor) cursors.add(cursor);
      } while (cursor);
      this.catalog = tools;
      this.catalogAt = this.now();
      this.recordDiscovery(options.runId, 'success', null, startedAt, tools.length);
      return tools;
    } catch (error) {
      if (error instanceof McpPolicyError) throw error;
      const mapped = mapMcpError(error);
      this.recordDiscovery(options.runId, 'failed', mapped.code, startedAt, null);
      throw mapped;
    }
  }

  async callTool(request: SellerSpriteToolCall): Promise<McpCallToolResult>;
  async callTool<T>(request: SellerSpriteToolCall, validate: (
    result: McpCallToolResult, acquisition: SellerSpriteMcpAcquisition,
  ) => SellerSpriteValidated<T>): Promise<T>;
  async callTool<T>(
    request: SellerSpriteToolCall, validate?: (
      result: McpCallToolResult, acquisition: SellerSpriteMcpAcquisition,
    ) => SellerSpriteValidated<T>,
  ): Promise<T | McpCallToolResult> {
    const key = requestKey([request.tool, request.arguments, request.context.capability,
      request.context.observationMonth, request.context.schemaHash,
      request.context.fresh ? request.context.runId ?? currentExecution().syncMode : 'incremental']);
    return this.requests.run(key, async () => {
      const database = this.options.budget?.database;
      if (!database || !this.options.cacheStore || request.context.fresh) return this.executeCall(request, validate);
      const owner = randomUUID();
      const leaseMs = Math.max(120000, (this.options.timeoutMs ?? 20000) * 3);
      const deadline = Date.now() + leaseMs;
      while (true) {
        database.prepare('DELETE FROM mcp_request_leases WHERE request_key=? AND expires_at<?').run(key, Date.now());
        const acquired = database.prepare('INSERT OR IGNORE INTO mcp_request_leases VALUES (?, ?, ?)').run(key, owner, Date.now() + leaseMs);
        if (acquired.changes === 1) break;
        if (Date.now() >= deadline) throw new SellerSpriteMcpError('TIMEOUT', 'Waiting for matching MCP acquisition timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const heartbeat = setInterval(() => database.prepare('UPDATE mcp_request_leases SET expires_at=? WHERE request_key=? AND owner=?')
        .run(Date.now() + leaseMs, key, owner), Math.floor(leaseMs / 3));
      try { return await this.executeCall(request, validate); }
      finally {
        clearInterval(heartbeat);
        database.prepare('DELETE FROM mcp_request_leases WHERE request_key=? AND owner=?').run(key, owner);
      }
    }, () => this.options.budget?.record(key, 'cache_hit'));
  }

  private async executeCall<T>(
    request: SellerSpriteToolCall, validate?: (
      result: McpCallToolResult, acquisition: SellerSpriteMcpAcquisition,
    ) => SellerSpriteValidated<T>,
  ): Promise<T | McpCallToolResult> {
    const key = createHash('sha256').update(JSON.stringify([
      request.tool, ordered(request.arguments), request.context.capability ?? '',
      request.context.observationMonth ?? '', request.context.schemaHash ?? '',
    ])).digest('hex');
    const now = new Date(this.now()).toISOString();
    const cached = request.context.fresh ? null : this.options.cacheStore?.get(key, now);
    if (cached && (request.context.cacheTtlMs === undefined
      || this.now() - Date.parse(cached.createdAt) < request.context.cacheTtlMs)) {
      let accepted: { raw: McpCallToolResult; value: T | McpCallToolResult;
        observationCertification?: McpCallLedgerEntry['observationCertification'] } | null = null;
      try {
        const result = mcpCallToolResultSchema.safeParse(JSON.parse(cached.responseJson) as unknown);
        if (result.success) {
          assertToolSuccess(result.data);
          const acquiredAt = normalizedTimestamp(cached.createdAt);
          accepted = { raw: result.data, ...(validate
            ? validate(result.data, { source: 'cache', acquiredAt }) : { value: result.data }) };
        }
      } catch {
        // A stale or malformed cache entry cannot certify a capability call.
      }
      if (accepted) {
        this.options.budget?.record(key, 'cache_hit');
        this.record(request, key, 'success', null, true, 0, now, countResult(accepted.raw),
          accepted.observationCertification);
        return accepted.value;
      }
    }

    const attempts = Math.max(1, Math.min(2, this.options.retry?.maxAttempts ?? 2));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = new Date(this.now()).toISOString();
      let remoteFailureRecorded = false;
      try {
        await this.acquireToken();
        const transport = await this.ensureTransport();
        const raw = await this.flights.run(`${key}:${request.context.fresh ? request.context.runId ?? currentExecution().syncMode : 'incremental'}`, async () => {
          this.options.budget?.beforeRemote(key, request.context.secondary);
          try {
            const response = await this.withTimeout((signal) => transport.callTool(
              { name: request.tool, arguments: request.arguments }, { signal },
            ));
            const parsedResponse = mcpCallToolResultSchema.safeParse(response);
            if (!parsedResponse.success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite MCP tool response');
            assertToolSuccess(parsedResponse.data);
            return response;
          } catch (error) {
            if (!(error instanceof McpPolicyError)) {
              this.options.budget?.result(mapMcpError(error).code);
              remoteFailureRecorded = true;
            }
            throw error;
          }
        });
        const parsed = mcpCallToolResultSchema.safeParse(raw);
        if (!parsed.success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite MCP tool response');
        assertToolSuccess(parsed.data);
        const acquiredAt = new Date(this.now()).toISOString();
        const accepted: SellerSpriteValidated<T | McpCallToolResult> = validate
          ? validate(parsed.data, { source: 'remote', acquiredAt }) : { value: parsed.data };
        this.options.budget?.result();
        this.record(request, key, 'success', null, false, attempt, startedAt, countResult(parsed.data),
          accepted.observationCertification);
        const ttl = request.context.cacheTtlMs ?? this.options.cacheTtlMs ?? 86400_000;
        if (this.options.cacheStore && ttl > 0) {
          try {
            this.options.cacheStore.set({
              cacheKey: key,
              provider: 'sellersprite',
              toolName: request.tool,
              responseJson: JSON.stringify(scrubSecrets(parsed.data)),
              createdAt: acquiredAt,
              expiresAt: new Date(this.now() + ttl).toISOString(),
            });
          } catch {
            // A validated provider response remains usable when the optional cache is unavailable.
          }
        }
        return accepted.value;
      } catch (error) {
        if (error instanceof McpPolicyError) throw error;
        const mapped = mapMcpError(error);
        if (!remoteFailureRecorded) this.options.budget?.result(mapped.code);
        this.record(request, key, 'failed', mapped.code, false, attempt, startedAt);
        if (attempt === attempts || !['RATE_LIMIT', 'TIMEOUT', 'REMOTE_ERROR'].includes(mapped.code)) throw mapped;
        await this.sleep((this.options.retry?.baseDelayMs ?? 250) * 2 ** (attempt - 1));
      }
    }
    throw new SellerSpriteMcpError('REMOTE_ERROR', 'SellerSprite MCP request failed');
  }

  async close(): Promise<void> {
    if (this.transport) await this.transport.close();
    this.connected = false;
    this.catalog = undefined;
    this.transport = this.options.transport;
  }

  private record(
    request: SellerSpriteToolCall, requestHash: string,
    status: 'success' | 'failed', errorCode: SellerSpriteMcpErrorCode | null,
    cacheHit: boolean, attempt: number, startedAt: string, resultCount: number | null = null,
    observationCertification?: McpCallLedgerEntry['observationCertification'],
  ): void {
    this.options.ledgerStore?.record(newLedgerEntry({
      provider: 'sellersprite',
      toolName: safeLabel(request.tool),
      capability: request.context.capability ? safeLabel(request.context.capability) : null,
      operation: request.context.operation ? safeLabel(request.context.operation) : null,
      status, errorCode, requestHash, cacheHit, attempt, startedAt,
      entityType: request.context.entityType,
      entityId: request.context.entityId
        ? safeEntityId(request.context.entityId, request.context.entityType) : undefined,
      researchJobId: request.context.researchJobId
        && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(request.context.researchJobId)
        ? request.context.researchJobId : undefined,
      runId: request.context.runId && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(request.context.runId)
        ? request.context.runId : undefined,
      observationMonth: safeObservationMonth(request.context.observationMonth),
      ...(status === 'success' && observationCertification ? { observationCertification } : {}),
      resultCount,
      completedAt: new Date(this.now()).toISOString(),
    }));
  }

  private recordDiscovery(
    runId: string | undefined,
    status: 'success' | 'failed',
    errorCode: SellerSpriteMcpErrorCode | null,
    startedAt: string,
    resultCount: number | null,
  ): void {
    this.options.ledgerStore?.record(newLedgerEntry({
      provider: 'sellersprite',
      toolName: 'list_tools',
      capability: 'LIST_TOOLS',
      operation: 'tool_discovery',
      status,
      errorCode,
      requestHash: createHash('sha256').update('list_tools').digest('hex'),
      cacheHit: false,
      attempt: 1,
      runId: runId && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(runId) ? runId : undefined,
      resultCount,
      startedAt,
      completedAt: new Date(this.now()).toISOString(),
    }));
  }

  private async acquireToken(): Promise<void> {
    const previous = this.rateQueue;
    let release = () => {};
    this.rateQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      while (true) {
        const now = this.now();
        this.tokens = Math.min(this.rateLimit.capacity,
          this.tokens + (now - this.lastRefill) * this.rateLimit.refillPerSecond / 1_000);
        this.lastRefill = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep(Math.ceil((1 - this.tokens) * 1_000 / this.rateLimit.refillPerSecond));
      }
    } finally { release(); }
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new SellerSpriteMcpError('TIMEOUT', 'SellerSprite MCP request timed out')),
      this.options.timeoutMs ?? 20_000);
    try { return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      }),
    ]); }
    finally { clearTimeout(timeout); }
  }

  private async runWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    const attempts = Math.max(1, Math.min(2, this.options.retry?.maxAttempts ?? 2));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        if (error instanceof McpPolicyError) throw error;
        const mapped = mapMcpError(error);
        if (attempt === attempts || !['RATE_LIMIT', 'TIMEOUT', 'REMOTE_ERROR'].includes(mapped.code)) throw mapped;
        await this.sleep((this.options.retry?.baseDelayMs ?? 250) * 2 ** (attempt - 1));
      }
    }
    throw new SellerSpriteMcpError('REMOTE_ERROR', 'SellerSprite MCP request failed');
  }
}

function safeObservationMonth(value: string | undefined): string | undefined {
  if (!value || !/^\d{6}$/.test(value)) return undefined;
  const month = Number(value.slice(4));
  return month >= 1 && month <= 12 ? value : undefined;
}

function normalizedTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid cached acquisition timestamp');
  return new Date(milliseconds).toISOString();
}

function assertToolSuccess(result: McpCallToolResult): void {
  if (result.isError) throw new SellerSpriteMcpError('REMOTE_ERROR', 'SellerSprite MCP tool returned an error');
  const payload = mcpJsonPayload(result);
  if (payload && typeof payload === 'object' && 'code' in payload
    && typeof payload.code === 'string' && payload.code !== 'OK') {
    throw new SellerSpriteMcpError('REMOTE_ERROR', 'SellerSprite rejected the tool request');
  }
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, ordered(item)]));
  }
  return value;
}

export function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.stringify(scrubSecrets(JSON.parse(value))); }
      catch { /* Fall through to plain-text sanitization. */ }
    }
    return sanitizeMcpError(value);
  }
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      isCredentialFieldName(key) || /endpoint|headers/i.test(key)
        ? '[REDACTED]' : scrubSecrets(item)]));
  }
  return value;
}

function safeLabel(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(value) ? value : '[REDACTED]';
}

function safeEntityId(value: string, type?: SellerSpriteToolCall['context']['entityType']): string | undefined {
  if (type === 'market' && /^\d+(?::\d+)*$/.test(value)) return value;
  if ((type === 'product' || type === 'competitor') && /^[A-Z0-9]{10}$/.test(value)) return value;
  return undefined;
}

function countResult(result: McpCallToolResult): number | null {
  const envelope = mcpJsonPayload(result);
  const payload = envelope && typeof envelope === 'object' && 'data' in envelope
    ? envelope.data : envelope;
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== 'object') return null;
  const object = payload as Record<string, unknown>;
  for (const key of ['salesTrendPoints', 'items']) {
    if (Array.isArray(object[key])) return object[key].length;
  }
  return 1;
}

function mapMcpError(error: unknown): SellerSpriteMcpError {
  if (error instanceof SellerSpriteMcpError) return error;
  const record = error && typeof error === 'object' ? error as { status?: number; code?: number | string; message?: string } : {};
  const status = record.status ?? record.code;
  const message = record.message ?? '';
  let code: SellerSpriteMcpErrorCode = 'REMOTE_ERROR';
  if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(message)) code = 'AUTH_ERROR';
  else if (status === 429 || /rate.limit|too.many.requests/i.test(message)) code = 'RATE_LIMIT';
  else if (status === 404 || /unknown.tool|tool.not.found/i.test(message)) code = 'TOOL_NOT_FOUND';
  else if (/abort|timed.out|timeout/i.test(message)) code = 'TIMEOUT';
  return new SellerSpriteMcpError(code, `SellerSprite MCP ${code.toLowerCase().replaceAll('_', ' ')}`);
}
