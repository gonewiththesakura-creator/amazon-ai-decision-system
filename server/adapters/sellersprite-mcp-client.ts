import { createHash } from 'node:crypto';
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
} from './sellersprite-mcp-store.js';
import { isCredentialFieldName, redactCredentialAssignments } from './sensitive-field.js';

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
    researchJobId?: string; runId?: string; observationMonth?: string; fresh?: boolean };
}

export interface SellerSpriteMcpAcquisition {
  source: 'remote' | 'cache';
  acquiredAt: string;
}

interface SellerSpriteMcpClientOptions {
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
  if (secret) endpoint.searchParams.set('secret-key', secret);
  return endpoint;
}

export class SellerSpriteMcpClient {
  private transport?: SellerSpriteMcpTransport;
  private connected = false;
  private catalog?: McpToolDefinition[];
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
      const sdkTransport = new StreamableHTTPClientTransport(endpoint);
      this.transport = {
        connect: (requestOptions) => sdkClient.connect(sdkTransport, requestOptions),
        ping: (requestOptions) => sdkClient.ping(requestOptions),
        listTools: (params, requestOptions) => sdkClient.listTools(params, requestOptions),
        callTool: (params, requestOptions) => sdkClient.callTool(params, undefined, requestOptions),
        close: () => sdkClient.close(),
      };
    }
    if (!this.connected) {
      await this.runWithRetry(() => this.withTimeout((signal) => this.transport!.connect({ signal })));
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
      const mapped = mapMcpError(error);
      return { connected: false, authenticated: mapped.code !== 'AUTH_ERROR', toolCount: 0, errorCode: mapped.code };
    }
  }

  async listTools(options: { fresh?: boolean; runId?: string } = {}): Promise<McpToolDefinition[]> {
    if (this.catalog && !options.fresh) return this.catalog;
    const startedAt = new Date(this.now()).toISOString();
    try {
      const transport = await this.ensureTransport();
      const tools: McpToolDefinition[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await this.runWithRetry(async () => {
          await this.acquireToken();
          return this.withTimeout((signal) => transport.listTools({ cursor }, { signal }));
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
      this.recordDiscovery(options.runId, 'success', null, startedAt, tools.length);
      return tools;
    } catch (error) {
      const mapped = mapMcpError(error);
      this.recordDiscovery(options.runId, 'failed', mapped.code, startedAt, null);
      throw mapped;
    }
  }

  async callTool(request: SellerSpriteToolCall): Promise<McpCallToolResult>;
  async callTool<T>(request: SellerSpriteToolCall, validate: (
    result: McpCallToolResult, acquisition: SellerSpriteMcpAcquisition,
  ) => T): Promise<T>;
  async callTool<T>(
    request: SellerSpriteToolCall, validate?: (
      result: McpCallToolResult, acquisition: SellerSpriteMcpAcquisition,
    ) => T,
  ): Promise<T | McpCallToolResult> {
    const key = createHash('sha256').update(JSON.stringify([
      request.tool, ordered(request.arguments), request.context.capability ?? '',
    ])).digest('hex');
    const now = new Date(this.now()).toISOString();
    const cached = request.context.fresh ? null : this.options.cacheStore?.get(key, now);
    if (cached) {
      let accepted: { raw: McpCallToolResult; value: T | McpCallToolResult } | null = null;
      try {
        const result = mcpCallToolResultSchema.safeParse(JSON.parse(cached.responseJson) as unknown);
        if (result.success) {
          assertToolSuccess(result.data);
          const acquiredAt = normalizedTimestamp(cached.createdAt);
          accepted = { raw: result.data, value: validate
            ? validate(result.data, { source: 'cache', acquiredAt }) : result.data };
        }
      } catch {
        // A stale or malformed cache entry cannot certify a capability call.
      }
      if (accepted) {
        this.record(request, key, 'success', null, true, 0, now, countResult(accepted.raw));
        return accepted.value;
      }
    }

    const attempts = Math.max(1, Math.min(3, this.options.retry?.maxAttempts ?? 3));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = new Date(this.now()).toISOString();
      try {
        await this.acquireToken();
        const transport = await this.ensureTransport();
        const raw = await this.withTimeout((signal) => transport.callTool(
          { name: request.tool, arguments: request.arguments }, { signal },
        ));
        const parsed = mcpCallToolResultSchema.safeParse(raw);
        if (!parsed.success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite MCP tool response');
        assertToolSuccess(parsed.data);
        const acquiredAt = new Date(this.now()).toISOString();
        const accepted = validate
          ? validate(parsed.data, { source: 'remote', acquiredAt }) : parsed.data;
        this.record(request, key, 'success', null, false, attempt, startedAt, countResult(parsed.data));
        if (this.options.cacheStore && (this.options.cacheTtlMs ?? 300_000) > 0) {
          this.options.cacheStore.set({
            cacheKey: key,
            provider: 'sellersprite',
            toolName: request.tool,
            responseJson: JSON.stringify(scrubSecrets(parsed.data)),
            createdAt: acquiredAt,
            expiresAt: new Date(this.now() + (this.options.cacheTtlMs ?? 300_000)).toISOString(),
          });
        }
        return accepted;
      } catch (error) {
        const mapped = mapMcpError(error);
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
    const attempts = Math.max(1, Math.min(3, this.options.retry?.maxAttempts ?? 3));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await operation(); }
      catch (error) {
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

function scrubSecrets(value: unknown): unknown {
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
