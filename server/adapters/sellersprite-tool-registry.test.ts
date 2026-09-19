import { describe, expect, it } from 'vitest';
import {
  SellerSpriteToolRegistry,
  type SellerSpriteCapability,
} from './sellersprite-tool-registry.js';
import type { McpToolDefinition } from './sellersprite-mcp-schemas.js';
import type {
  McpCapabilitySnapshot,
  McpCapabilityStore,
} from './sellersprite-mcp-store.js';

describe('SellerSpriteToolRegistry', () => {
  it('maps all stable capabilities from explicit aliases and required schema signals', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });

    const snapshot = await registry.refresh(async () => discoveredTools);

    expect(snapshot.missingCapabilities).toEqual([]);
    expect(registry.resolve('ASIN_SALES_TREND')?.inputSchema.required).toContain('asin');
    expect(registry.resolve('MARKET_RESEARCH')?.name).toBe('market_research');
    expect(registry.resolve('MARKET_STATISTICS')?.inputSchema.required).toContain('request');
    expect(store.snapshots).toHaveLength(1);
    expect(JSON.stringify(store.snapshots)).not.toMatch(/endpoint|Authorization|secret-value/i);
  });

  it('marks a capability missing when names, descriptions, and schemas do not support it', async () => {
    const registry = new SellerSpriteToolRegistry();

    const snapshot = await registry.refresh(async () => [{
      name: 'account_preferences',
      description: 'Read account display preferences',
      inputSchema: {
        type: 'object',
        properties: { locale: { type: 'string' } },
        required: ['locale'],
      },
    }]);

    expect(snapshot.missingCapabilities).toEqual([
      'MARKET_RESEARCH',
      'MARKET_STATISTICS',
      'PRODUCT_CONCENTRATION',
      'ASIN_SALES_TREND',
      'ASIN_COMPETITOR_DISCOVERY',
    ]);
    expect(registry.resolve('ASIN_SALES_TREND')).toBeUndefined();
  });

  it('does not map an ASIN tool to a capability when the required ASIN argument is absent', async () => {
    const registry = new SellerSpriteToolRegistry();

    await registry.refresh(async () => [{
      name: 'asin_sales_trend',
      description: 'Historical sales trend for an ASIN',
      inputSchema: {
        type: 'object',
        properties: { marketplace: { type: 'string' } },
        required: ['marketplace'],
      },
    }]);

    expect(registry.resolve('ASIN_SALES_TREND')).toBeUndefined();
    expect(registry.missing()).toContain('ASIN_SALES_TREND');
  });

  it('retains only safe tool metadata in persisted capability snapshots', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });
    const unsafeTool = {
      ...discoveredTools[0],
      endpoint: 'https://example.test/mcp?token=secret-value',
      headers: { Authorization: 'Bearer secret-value' },
      _meta: { secretKey: 'secret-value' },
    };

    await registry.refresh(async () => [unsafeTool]);

    expect(store.snapshots[0].tools).toEqual([{
      name: unsafeTool.name,
      description: unsafeTool.description,
      inputSchema: unsafeTool.inputSchema,
    }]);
    expect(JSON.stringify(store.snapshots[0])).not.toMatch(/secret-value|Authorization|endpoint/i);
  });

  it('redacts credential-bearing schema defaults and descriptions before persistence', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });

    await registry.refresh(async () => [{
      name: 'market_research_statistics',
      description: 'Authorization: Bearer secret-value',
      inputSchema: {
        type: 'object', required: ['request'],
        properties: {
          request: { type: 'object', required: ['marketplace'], properties: {
            marketplace: { type: 'string' },
            secretKey: { type: 'string', default: 'secret-value' },
          } },
        },
      },
    }]);

    expect(JSON.stringify(store.snapshots)).not.toMatch(/secret-value|Authorization/i);
    expect(store.snapshots[0].tools[0].inputSchema.required).toContain('request');
  });

  it('does not persist a credential-bearing mapped tool name while retaining the callable name', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });
    const callableName = 'asin_sales_trend?api_key=opaque-fixture-value';

    const snapshot = await registry.refresh(async () => [mcpTool(
      callableName, 'Historical sales trend for an ASIN', ['marketplace', 'asin'],
    )]);

    expect(snapshot.capabilities.ASIN_SALES_TREND).toBe('[REDACTED]');
    expect(JSON.stringify(store.snapshots)).not.toContain('opaque-fixture-value');
    expect(registry.resolve('ASIN_SALES_TREND')?.name).toBe(callableName);
  });

  it('does not persist opaque enum values from discovered tool schemas', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });

    await registry.refresh(async () => [{
      name: 'asin_sales_trend',
      inputSchema: {
        type: 'object', required: ['asin'],
        properties: {
          asin: { type: 'string', enum: ['B000000001', 'opaque-credential-fixture'] },
          filter: { type: 'object', enum: [{ value: 'opaque-nested-fixture' }] },
        },
      },
    }]);

    expect(JSON.stringify(store.snapshots)).not.toMatch(/B000000001|opaque-credential-fixture|opaque-nested-fixture/);
    expect(registry.resolve('ASIN_SALES_TREND')?.inputSchema.properties?.asin).toEqual({
      type: 'string', enum: ['B000000001', 'opaque-credential-fixture'],
    });
  });

  it('rejects a requested month that a strict flat tool schema cannot receive', async () => {
    const registry = new SellerSpriteToolRegistry();
    await registry.refresh(async () => [{
      name: 'market_research_statistics',
      inputSchema: {
        type: 'object', required: ['marketplace', 'nodeIdPath'], additionalProperties: false,
        properties: { marketplace: { type: 'string' }, nodeIdPath: { type: 'string' } },
      },
    }]);

    expect(() => registry.argumentsFor('MARKET_STATISTICS', {
      request: { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' },
    })).toThrow(/month/);
  });

  it('rejects a requested month that a strict nested request schema cannot receive', async () => {
    const registry = new SellerSpriteToolRegistry();
    await registry.refresh(async () => [{
      name: 'market_research_statistics',
      inputSchema: {
        type: 'object', required: ['request'], additionalProperties: false,
        properties: { request: {
          type: 'object', required: ['marketplace', 'nodeIdPath'], additionalProperties: false,
          properties: { marketplace: { type: 'string' }, nodeIdPath: { type: 'string' } },
        } },
      },
    }]);

    expect(() => registry.argumentsFor('MARKET_STATISTICS', {
      request: { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' },
    })).toThrow(/month/);
  });
});

const discoveredTools: McpToolDefinition[] = [
  mcpTool('market_research', 'Research products in an Amazon market', ['request']),
  mcpTool('market_research_statistics', 'Market sales and revenue statistics', ['request']),
  mcpTool('market_product_concentration', 'Calculate brand and product concentration', ['request']),
  mcpTool('asin_sales_trend', 'Historical sales trend for a selected ASIN', ['marketplace', 'asin']),
  mcpTool('asin_competitor', 'Find direct competitor ASINs', ['marketplace', 'asin']),
];

function mcpTool(name: string, description: string, required: string[]): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(required.map((field) => [field, field === 'request'
        ? { type: 'object', properties: { marketplace: { type: 'string' }, nodeIdPath: { type: 'string' } }, required: ['marketplace', 'nodeIdPath'] }
        : { type: 'string' }])),
      required,
      additionalProperties: false,
    },
  };
}

class MemoryCapabilityStore implements McpCapabilityStore {
  readonly snapshots: McpCapabilitySnapshot[] = [];
  save(snapshot: McpCapabilitySnapshot): void { this.snapshots.push(snapshot); }
  latest(): McpCapabilitySnapshot | null { return this.snapshots.at(-1) ?? null; }
}

const _allCapabilitiesAreCovered: Record<SellerSpriteCapability, true> = {
  MARKET_RESEARCH: true,
  MARKET_STATISTICS: true,
  PRODUCT_CONCENTRATION: true,
  ASIN_SALES_TREND: true,
  ASIN_COMPETITOR_DISCOVERY: true,
};
void _allCapabilitiesAreCovered;
