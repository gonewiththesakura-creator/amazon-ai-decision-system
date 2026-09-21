import { describe, expect, it } from 'vitest';
import {
  SELLERSPRITE_CAPABILITIES,
  sellerSpriteSchemaHash,
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
    const runId = '123e4567-e89b-42d3-a456-426614174000';

    const snapshot = await registry.refresh(async () => discoveredTools, runId);

    expect(snapshot.missingCapabilities).toEqual([]);
    expect(snapshot.runId).toBe(runId);
    expect(registry.resolve('ASIN_SALES_TREND')?.inputSchema.required).toContain('asin');
    expect(registry.resolve('MARKET_RESEARCH')?.name).toBe('market_research');
    expect(registry.resolve('MARKET_STATISTICS')?.inputSchema.required).toContain('request');
    expect(store.snapshots).toHaveLength(1);
    expect(JSON.stringify(store.snapshots)).not.toMatch(/endpoint|Authorization|secret-value/i);
  });

  it('maps asin_detail as optional without changing the five required capabilities', async () => {
    const registry = new SellerSpriteToolRegistry();
    const detail = mcpTool('asin_detail', 'Get ASIN product identity', ['marketplace', 'asin']);
    detail.inputSchema.properties = {
      ...detail.inputSchema.properties,
      returnFields: { type: 'string' },
    };

    const snapshot = await registry.refresh(async () => [...discoveredTools, detail]);

    expect(SELLERSPRITE_CAPABILITIES).toHaveLength(5);
    expect(snapshot.missingCapabilities).toEqual([]);
    expect(snapshot.capabilities.ASIN_DETAIL).toBe('asin_detail');
    expect(registry.resolve('ASIN_DETAIL')?.name).toBe('asin_detail');
  });

  it('does not report absent optional asin_detail as a missing required capability', async () => {
    const registry = new SellerSpriteToolRegistry();

    const snapshot = await registry.refresh(async () => discoveredTools);

    expect(snapshot.missingCapabilities).toEqual([]);
    expect(snapshot.capabilities).not.toHaveProperty('ASIN_DETAIL');
    expect(registry.resolve('ASIN_DETAIL')).toBeUndefined();
  });

  it('does not let a coupon-trend tool substitute for the optional ASIN identity capability', async () => {
    const registry = new SellerSpriteToolRegistry();

    const snapshot = await registry.refresh(async () => [mcpTool(
      'asin_detail_with_coupon_trend',
      'Returns coupon and promotion trends for an ASIN',
      ['marketplace', 'asin'],
    )]);

    expect(registry.resolve('ASIN_DETAIL')).toBeUndefined();
    expect(snapshot.capabilities).not.toHaveProperty('ASIN_DETAIL');
  });

  it('never lets optional asin_detail substitute for the critical ASIN trend capability', async () => {
    const registry = new SellerSpriteToolRegistry();

    const snapshot = await registry.refresh(async () => [mcpTool(
      'asin_detail', 'ASIN detail with current sales trend summary', ['marketplace', 'asin'],
    )]);

    expect(registry.resolve('ASIN_DETAIL')?.name).toBe('asin_detail');
    expect(registry.resolve('ASIN_SALES_TREND')).toBeUndefined();
    expect(snapshot.missingCapabilities).toContain('ASIN_SALES_TREND');
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

  it('does not certify an ASIN capability when marketplace is absent from its required schema', async () => {
    const registry = new SellerSpriteToolRegistry();

    await registry.refresh(async () => [mcpTool(
      'asin_sales_trend', 'Historical sales trend for an ASIN', ['asin'],
    )]);

    expect(registry.resolve('ASIN_SALES_TREND')).toBeUndefined();
    expect(registry.missing()).toContain('ASIN_SALES_TREND');
  });

  it.each(['MARKET_STATISTICS', 'PRODUCT_CONCENTRATION'] as const)(
    'does not certify %s without required nodeIdPath scope',
    async (capability) => {
      const registry = new SellerSpriteToolRegistry();
      const name = capability === 'MARKET_STATISTICS'
        ? 'market_research_statistics' : 'market_product_concentration';

      await registry.refresh(async () => [mcpTool(
        name, 'Scoped market data', ['marketplace'],
      )]);

      expect(registry.resolve(capability)).toBeUndefined();
      expect(registry.missing()).toContain(capability);
    },
  );

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
      description: '[REDACTED]',
      inputSchema: unsafeTool.inputSchema,
      schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
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

  it('redacts auth and session values from tool names and descriptions', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });
    const callableName = 'asin_sales_trend?auth=opaque987654';
    const snapshot = await registry.refresh(async () => [mcpTool(
      callableName, 'Sales trend session=opaque456789', ['marketplace', 'asin'],
    )]);

    expect(snapshot.capabilities.ASIN_SALES_TREND).toBe('[REDACTED]');
    expect(JSON.stringify(store.snapshots)).not.toMatch(/opaque987654|opaque456789/);
    expect(registry.resolve('ASIN_SALES_TREND')?.name).toBe(callableName);
  });

  it('never persists arbitrary provider description text', async () => {
    const store = new MemoryCapabilityStore();
    await new SellerSpriteToolRegistry({ store }).refresh(async () => [mcpTool(
      'asin_sales_trend', 'Opaque 987654321 fixture', ['marketplace', 'asin'],
    )]);

    expect(JSON.stringify(store.snapshots)).not.toContain('Opaque 987654321 fixture');
  });

  it('does not persist opaque enum values from discovered tool schemas', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });

    await registry.refresh(async () => [{
      name: 'asin_sales_trend',
      inputSchema: {
        type: 'object', required: ['marketplace', 'asin'],
        properties: {
          marketplace: { type: 'string' },
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

  it('fingerprints allowlisted contract enums without making credentials or product identities an oracle', () => {
    const schemaFor = (
      marketplace: string, secret: string, identity: string,
      identityPath = 'asin', credentialPath = 'secretKey',
    ) => ({
      type: 'object', required: ['marketplace', identityPath, credentialPath],
      properties: {
        marketplace: { type: 'string', enum: [marketplace] },
        [identityPath]: { type: 'string', enum: [identity] },
        [credentialPath]: { type: 'string', default: secret },
      },
    });

    const baseline = sellerSpriteSchemaHash(schemaFor('US', 'secret-alpha', 'B000000001'));
    const changedSensitiveValues = sellerSpriteSchemaHash(
      schemaFor('US', 'secret-beta', 'B000000002'),
    );
    const changedSensitivePaths = sellerSpriteSchemaHash(
      schemaFor('US', 'secret-beta', 'SKU-002', 'sku', 'accessToken'),
    );
    const changedContract = sellerSpriteSchemaHash(
      schemaFor('CA', 'secret-alpha', 'B000000001'),
    );

    expect(changedSensitiveValues).toBe(baseline);
    expect(changedSensitivePaths).toBe(baseline);
    expect(changedContract).not.toBe(baseline);
  });

  it('does not fingerprint numeric, boolean, or nested values under credential and identity paths', () => {
    const schemaFor = (credentialMetadata: unknown, identityMetadata: unknown) => ({
      type: 'object',
      properties: {
        marketplace: { type: 'string', enum: ['US'] },
        apiKey: { type: 'string', 'x-token-state': credentialMetadata },
        auth: { type: 'string', 'x-auth': credentialMetadata },
        authHeader: { type: 'string', 'x-auth-header': credentialMetadata },
        asin: { type: 'string', 'x-account-id': identityMetadata },
      },
      'x-api-key': credentialMetadata,
      'x-auth': credentialMetadata,
      'x-customer-account': identityMetadata,
    });

    expect(sellerSpriteSchemaHash(schemaFor(123456, { enabled: true, identity: 991122 })))
      .toBe(sellerSpriteSchemaHash(schemaFor([{ pin: 654321 }], false)));
  });

  it('does not persist low-entropy values under sensitive schema paths while keeping tools callable', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });
    const tool: McpToolDefinition = {
      name: 'asin_sales_trend',
      inputSchema: {
        type: 'object', required: ['marketplace', 'asin'],
        properties: {
          marketplace: { type: 'string' },
          asin: { type: 'string', 'x-customer-number': 991122 },
          apiKey: { type: 'string', 'x-pin': 123456, 'x-enabled': true },
          auth: { type: 'string', 'x-auth': 777888 },
          authenticationHeader: { type: 'string', 'x-auth-header': 111222 },
        },
        'x-api-key': { pin: 654321, enabled: false },
        'x-auth': { pin: 888999, enabled: true },
      },
    };

    await registry.refresh(async () => [tool]);

    expect(JSON.stringify(store.snapshots)).not.toMatch(/991122|123456|654321|777888|888999|111222/);
    expect(registry.resolve('ASIN_SALES_TREND')?.inputSchema).toEqual(tool.inputSchema);
    expect(() => registry.validateArguments('ASIN_SALES_TREND', {
      marketplace: 'US', asin: 'B000000001',
    })).not.toThrow();
  });

  it('does not persist or fingerprint opaque metadata on otherwise safe schema fields', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });
    const schemaFor = (opaque: unknown): McpToolDefinition => ({
      name: 'asin_sales_trend',
      inputSchema: {
        type: 'object', required: ['marketplace', 'asin'],
        properties: {
          marketplace: { type: 'string', 'x-note': opaque },
          asin: { type: 'string' },
        },
        'x-provider-metadata': opaque,
      },
    });

    expect(sellerSpriteSchemaHash(schemaFor(123456).inputSchema))
      .toBe(sellerSpriteSchemaHash(schemaFor({ value: 'opaque-sensitive-value-123' }).inputSchema));
    await registry.refresh(async () => [schemaFor('opaque-sensitive-value-123')]);
    expect(JSON.stringify(store.snapshots)).not.toContain('opaque-sensitive-value-123');
    expect(registry.resolve('ASIN_SALES_TREND')?.inputSchema)
      .toEqual(schemaFor('opaque-sensitive-value-123').inputSchema);
  });

  it('canonicalizes allowlisted enum order', () => {
    const schemaFor = (marketplaces: string[]) => ({
      type: 'object',
      properties: { marketplace: { type: 'string', enum: marketplaces } },
    });

    expect(sellerSpriteSchemaHash(schemaFor(['US', 'CA'])))
      .toBe(sellerSpriteSchemaHash(schemaFor(['CA', 'US'])));
  });

  it('fingerprints the safe schema contract before persistence, including marketplace enum changes', async () => {
    const first = new SellerSpriteToolRegistry();
    const second = new SellerSpriteToolRegistry();
    const schemaFor = (marketplace: string): McpToolDefinition => ({
      name: 'asin_sales_trend',
      inputSchema: {
        type: 'object', required: ['marketplace', 'asin'],
        properties: {
          marketplace: { type: 'string', enum: [marketplace] },
          asin: { type: 'string' },
        },
      },
    });

    const us = await first.refresh(async () => [schemaFor('US')]);
    const ca = await second.refresh(async () => [schemaFor('CA')]);

    expect(us.tools[0]?.inputSchema).toEqual(ca.tools[0]?.inputSchema);
    expect(us.tools[0]?.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ca.tools[0]?.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(us.tools[0]?.schemaHash).not.toBe(ca.tools[0]?.schemaHash);
    expect(JSON.stringify({ us, ca })).not.toMatch(/"US"|"CA"/);
  });

  it('binds schema hashes directly to capabilities when sanitized tool names collide', async () => {
    const store = new MemoryCapabilityStore();
    const registry = new SellerSpriteToolRegistry({ store });
    const statistics = mcpTool(
      'market_research_statistics?api_key=opaque-statistics',
      'Monthly market statistics',
      ['request'],
    );
    statistics.inputSchema.properties = {
      request: {
        type: 'object',
        properties: {
          marketplace: { type: 'string', enum: ['US'] },
          nodeIdPath: { type: 'string' },
        },
        required: ['marketplace', 'nodeIdPath'],
      },
    };
    const concentration = mcpTool(
      'market_product_concentration?token=opaque-concentration',
      'Product concentration',
      ['request'],
    );
    concentration.inputSchema.properties = {
      request: {
        type: 'object',
        properties: {
          marketplace: { type: 'string', enum: ['CA'] },
          nodeIdPath: { type: 'string' },
        },
        required: ['marketplace', 'nodeIdPath'],
      },
    };

    const snapshot = await registry.refresh(async () => [statistics, concentration]);
    const withCapabilityHashes = snapshot as McpCapabilitySnapshot & {
      capabilitySchemaHashes?: Partial<Record<SellerSpriteCapability, string>>;
    };

    expect(snapshot.capabilities).toMatchObject({
      MARKET_STATISTICS: '[REDACTED]',
      PRODUCT_CONCENTRATION: '[REDACTED]',
    });
    expect(withCapabilityHashes.capabilitySchemaHashes).toMatchObject({
      MARKET_STATISTICS: sellerSpriteSchemaHash(statistics.inputSchema),
      PRODUCT_CONCENTRATION: sellerSpriteSchemaHash(concentration.inputSchema),
    });
    expect(withCapabilityHashes.capabilitySchemaHashes?.MARKET_STATISTICS)
      .not.toBe(withCapabilityHashes.capabilitySchemaHashes?.PRODUCT_CONCENTRATION);
    expect(JSON.stringify(snapshot)).not.toMatch(/opaque-statistics|opaque-concentration/);
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

  it('reports whether a discovered market capability explicitly declares an argument', async () => {
    const registry = new SellerSpriteToolRegistry();
    await registry.refresh(async () => [mcpTool(
      'market_research_statistics', 'Monthly market statistics',
      ['request'],
    )]);

    expect(registry.supportsArgument('MARKET_STATISTICS', 'marketplace')).toBe(true);
    expect(registry.supportsArgument('MARKET_STATISTICS', 'month')).toBe(false);
  });

  it.each([
    ['flat', {
      type: 'object', required: ['marketplace', 'nodeIdPath'],
      properties: {
        marketplace: { type: 'string' }, nodeIdPath: { type: 'string' },
        returnFields: { type: 'array' },
      },
    }],
    ['nested', {
      type: 'object', required: ['request'],
      properties: { request: {
        type: 'object', required: ['marketplace', 'nodeIdPath'],
        properties: {
          marketplace: { type: 'string' }, nodeIdPath: { type: 'string' },
          returnFields: { type: 'number' },
        },
      } },
    }],
  ])('does not certify a non-string %s returnFields argument', async (_shape, inputSchema) => {
    const registry = new SellerSpriteToolRegistry();
    await registry.refresh(async () => [{
      name: 'market_research_statistics',
      inputSchema: inputSchema as McpToolDefinition['inputSchema'],
    }]);

    expect(registry.supportsArgument('MARKET_STATISTICS', 'returnFields')).toBe(true);
    expect(registry.supportsStringArgument('MARKET_STATISTICS', 'returnFields')).toBe(false);
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
  ASIN_DETAIL: true,
};
void _allCapabilitiesAreCovered;
