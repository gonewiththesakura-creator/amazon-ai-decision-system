import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database.js';
import type { McpToolDefinition } from './sellersprite-mcp-schemas.js';
import type { SellerSpriteCapability } from './sellersprite-tool-registry.js';

export interface McpCapabilitySnapshot {
  id: string;
  provider: 'sellersprite';
  discoveredAt: string;
  tools: Array<Pick<McpToolDefinition, 'name' | 'description' | 'inputSchema'>>;
  capabilities: Partial<Record<SellerSpriteCapability, string>>;
  missingCapabilities: SellerSpriteCapability[];
}

export interface McpCapabilityStore {
  save(snapshot: McpCapabilitySnapshot): void;
  latest(): McpCapabilitySnapshot | null;
}

export interface McpCallLedgerEntry {
  id: string;
  provider: 'sellersprite';
  toolName: string;
  capability: string | null;
  operation: string | null;
  status: 'success' | 'failed';
  errorCode: string | null;
  requestHash: string;
  cacheHit: boolean;
  attempt: number;
  startedAt: string;
  completedAt: string;
}

export interface McpCallLedgerStore {
  record(entry: McpCallLedgerEntry): void;
}

export interface McpCacheEntry {
  cacheKey: string;
  provider: 'sellersprite';
  toolName: string;
  responseJson: string;
  createdAt: string;
  expiresAt: string;
}

export interface McpResponseCacheStore {
  get(cacheKey: string, now: string): McpCacheEntry | null;
  set(entry: McpCacheEntry): void;
}

export class SqliteMcpCapabilityStore implements McpCapabilityStore {
  constructor(private readonly database: AppDatabase) {}

  save(snapshot: McpCapabilitySnapshot): void {
    this.database.prepare(`
      INSERT INTO provider_capability_snapshots
        (id, provider_id, capabilities_json, collected_at, expires_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(snapshot.id, snapshot.provider, JSON.stringify({
      tools: snapshot.tools,
      capabilities: snapshot.capabilities,
      missingCapabilities: snapshot.missingCapabilities,
    }), snapshot.discoveredAt);
  }

  latest(): McpCapabilitySnapshot | null {
    const row = this.database.prepare(`
      SELECT id, provider_id, collected_at, capabilities_json
      FROM provider_capability_snapshots WHERE provider_id = 'sellersprite'
      ORDER BY collected_at DESC, rowid DESC LIMIT 1
    `).get() as Record<string, string> | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.capabilities_json) as Pick<McpCapabilitySnapshot,
      'tools' | 'capabilities' | 'missingCapabilities'>;
    return { id: row.id, provider: 'sellersprite', discoveredAt: row.collected_at, ...payload };
  }
}

export class SqliteMcpCallLedgerStore implements McpCallLedgerStore {
  constructor(private readonly database: AppDatabase) {}

  record(entry: McpCallLedgerEntry): void {
    this.database.prepare(`
      INSERT INTO mcp_call_logs
        (id, provider_id, capability, request_hash, status, response_metadata_json,
         error_code, started_at, completed_at, actual_tool, parameter_hash,
         duration_ms, cache_hit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.provider, entry.capability ?? 'unspecified', entry.requestHash,
      entry.status, JSON.stringify({ operation: entry.operation, attempt: entry.attempt }),
      entry.errorCode, entry.startedAt, entry.completedAt, entry.toolName, entry.requestHash,
      Math.max(0, Date.parse(entry.completedAt) - Date.parse(entry.startedAt)), entry.cacheHit ? 1 : 0);
  }
}

export class SqliteMcpResponseCacheStore implements McpResponseCacheStore {
  constructor(private readonly database: AppDatabase) {}

  get(cacheKey: string, now: string): McpCacheEntry | null {
    const row = this.database.prepare(`
      SELECT cache_key, provider_id, response_json, created_at, expires_at
      FROM mcp_response_cache WHERE cache_key = ? AND expires_at > ?
    `).get(cacheKey, now) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      cacheKey: row.cache_key, provider: 'sellersprite', toolName: '',
      responseJson: row.response_json, createdAt: row.created_at, expiresAt: row.expires_at,
    };
  }

  set(entry: McpCacheEntry): void {
    this.database.prepare(`
      INSERT INTO mcp_response_cache
        (cache_key, provider_id, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json,
        created_at = excluded.created_at, expires_at = excluded.expires_at
    `).run(entry.cacheKey, entry.provider, entry.responseJson,
      entry.createdAt, entry.expiresAt);
  }
}

export function newLedgerEntry(fields: Omit<McpCallLedgerEntry, 'id'>): McpCallLedgerEntry {
  return { id: randomUUID(), ...fields };
}
