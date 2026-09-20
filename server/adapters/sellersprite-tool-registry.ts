import { randomUUID } from 'node:crypto';
import { mcpToolSchema, type McpToolDefinition } from './sellersprite-mcp-schemas.js';
import type { McpCapabilitySnapshot, McpCapabilityStore } from './sellersprite-mcp-store.js';

export const SELLERSPRITE_CAPABILITIES = [
  'MARKET_RESEARCH',
  'MARKET_STATISTICS',
  'PRODUCT_CONCENTRATION',
  'ASIN_SALES_TREND',
  'ASIN_COMPETITOR_DISCOVERY',
] as const;

export type SellerSpriteCapability = typeof SELLERSPRITE_CAPABILITIES[number];

const aliases: Record<SellerSpriteCapability, string[]> = {
  MARKET_RESEARCH: ['market_research'],
  MARKET_STATISTICS: ['market_research_statistics', 'market_statistics'],
  PRODUCT_CONCENTRATION: ['market_product_concentration', 'product_concentration'],
  ASIN_SALES_TREND: ['asin_sales_trend'],
  ASIN_COMPETITOR_DISCOVERY: ['asin_competitor', 'asin_competitor_discovery'],
};

const signals: Record<SellerSpriteCapability, RegExp> = {
  MARKET_RESEARCH: /market.*research|research.*market/i,
  MARKET_STATISTICS: /market.*statistic|statistic.*market/i,
  PRODUCT_CONCENTRATION: /product.*concentration|brand.*concentration/i,
  ASIN_SALES_TREND: /asin.*sales.*trend|sales.*trend.*asin/i,
  ASIN_COMPETITOR_DISCOVERY: /asin.*competitor|competitor.*asin/i,
};

export class SellerSpriteToolRegistry {
  private tools: McpToolDefinition[] = [];
  private readonly mapping = new Map<SellerSpriteCapability, McpToolDefinition>();

  constructor(private readonly options: { store?: McpCapabilityStore; now?: () => Date } = {}) {}

  async refresh(
    discover: () => Promise<McpToolDefinition[]>, runId: string | null = null,
  ): Promise<McpCapabilitySnapshot> {
    this.tools = (await discover()).map((tool) => mcpToolSchema.parse(tool));
    this.mapping.clear();
    const assigned = new Set<string>();
    for (const capability of SELLERSPRITE_CAPABILITIES) {
      const candidate = this.tools
        .filter((tool) => !assigned.has(tool.name) && supportsSchema(capability, tool))
        .map((tool) => ({ tool, score: scoreTool(capability, tool) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)[0]?.tool;
      if (candidate) {
        this.mapping.set(capability, candidate);
        assigned.add(candidate.name);
      }
    }
    const snapshot: McpCapabilitySnapshot = {
      id: randomUUID(),
      provider: 'sellersprite',
      runId,
      discoveredAt: (this.options.now?.() ?? new Date()).toISOString(),
      tools: this.tools.map((tool) => ({
        name: safeMetadataText(tool.name),
        description: tool.description ? safeMetadataText(tool.description) : undefined,
        inputSchema: safeInputSchema(tool.inputSchema),
      })),
      capabilities: Object.fromEntries(
        [...this.mapping].map(([capability, tool]) => [capability, safeMetadataText(tool.name)]),
      ) as Partial<Record<SellerSpriteCapability, string>>,
      missingCapabilities: this.missing(),
    };
    this.options.store?.save(snapshot);
    return snapshot;
  }

  resolve(capability: SellerSpriteCapability): McpToolDefinition | undefined {
    return this.mapping.get(capability);
  }

  missing(): SellerSpriteCapability[] {
    return SELLERSPRITE_CAPABILITIES.filter((capability) => !this.mapping.has(capability));
  }

  supportsArgument(capability: SellerSpriteCapability, argument: string): boolean {
    const tool = this.mapping.get(capability);
    if (!tool) return false;
    const schema = capability.startsWith('ASIN_')
      ? tool.inputSchema : marketRequestSchema(tool.inputSchema);
    return Boolean(schema && Object.hasOwn(schema.properties ?? {}, argument));
  }

  validateArguments(capability: SellerSpriteCapability, args: Record<string, unknown>): void {
    const tool = this.mapping.get(capability);
    if (!tool) throw new Error(`SellerSprite capability unavailable: ${capability}`);
    validateRequired(tool.inputSchema, args, tool.name);
  }

  argumentsFor(capability: SellerSpriteCapability, args: Record<string, unknown>): Record<string, unknown> {
    const tool = this.mapping.get(capability);
    if (!tool) throw new Error(`SellerSprite capability unavailable: ${capability}`);
    const request = args.request;
    const flattened = !Object.hasOwn(tool.inputSchema.properties ?? {}, 'request')
      && request && typeof request === 'object' && !Array.isArray(request)
      ? request as Record<string, unknown>
      : args;
    validateRequired(tool.inputSchema, flattened, tool.name);
    return flattened;
  }
}

function supportsSchema(capability: SellerSpriteCapability, tool: McpToolDefinition): boolean {
  const schema = capability.startsWith('ASIN_')
    ? tool.inputSchema : marketRequestSchema(tool.inputSchema);
  if (!schema) return false;
  const requiredScope = capability.startsWith('ASIN_')
    ? ['marketplace', 'asin']
    : capability === 'MARKET_RESEARCH' ? ['marketplace'] : ['marketplace', 'nodeIdPath'];
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};
  return requiredScope.every((field) => required.includes(field) && Object.hasOwn(properties, field));
}

function marketRequestSchema(
  schema: McpToolDefinition['inputSchema'],
): McpToolDefinition['inputSchema'] | null {
  const request = schema.properties?.request;
  if (!schema.required?.includes('request')) return schema;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const nested = request as Record<string, unknown>;
  if (nested.type !== 'object') return null;
  return {
    type: 'object',
    properties: typeof nested.properties === 'object' && nested.properties !== null
      ? nested.properties as Record<string, unknown> : undefined,
    required: Array.isArray(nested.required)
      ? nested.required.filter((field: unknown): field is string => typeof field === 'string') : undefined,
  };
}

function scoreTool(capability: SellerSpriteCapability, tool: McpToolDefinition): number {
  const aliasIndex = aliases[capability].indexOf(tool.name.toLowerCase());
  if (aliasIndex >= 0) return 100 - aliasIndex;
  if (capability === 'MARKET_RESEARCH' && /statistics|concentration/i.test(tool.name)) return 0;
  return signals[capability].test(`${tool.name} ${tool.description ?? ''}`) ? 10 : 0;
}

function safeMetadataText(value: string): string {
  return /https?:\/\/|authorization|bearer|secret|token|api[_-]?key|password/i.test(value)
    ? '[REDACTED]' : value;
}

function safeInputSchema(schema: McpToolDefinition['inputSchema']): McpToolDefinition['inputSchema'] {
  return safeSchemaProperty(schema) as McpToolDefinition['inputSchema'];
}

function safeSchemaProperty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const safeKey = safeMetadataText(key);
    if (/^(?:enum|const|default|examples?)$/i.test(key)) {
      return [safeKey, Array.isArray(item) ? item.map(() => '[REDACTED]') : '[REDACTED]'];
    }
    if (Array.isArray(item)) return [safeKey, item.map((entry) => {
      if (typeof entry === 'string') return safeMetadataText(entry);
      if (entry && typeof entry === 'object') return safeSchemaProperty(entry);
      return entry;
    })];
    if (item && typeof item === 'object') return [safeKey, safeSchemaProperty(item)];
    if (typeof item === 'string') return [safeKey, safeMetadataText(item)];
    return [safeKey, item];
  }));
}

function validateRequired(schema: McpToolDefinition['inputSchema'], args: Record<string, unknown>, path: string): void {
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) {
        throw new Error(`Unsupported SellerSprite tool argument: ${path}.${key}`);
      }
    }
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new Error(`Missing required SellerSprite tool argument: ${path}.${key}`);
    }
    const property = schema.properties?.[key];
    if (property && typeof property === 'object' && !Array.isArray(property)) {
      const nested = property as {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };
      if (nested.type === 'object') {
        if (typeof args[key] !== 'object' || Array.isArray(args[key])) {
          throw new Error(`Invalid SellerSprite tool argument: ${path}.${key}`);
        }
        validateRequired({
          type: 'object', properties: nested.properties, required: nested.required,
          additionalProperties: nested.additionalProperties,
        },
          args[key] as Record<string, unknown>, `${path}.${key}`);
      }
    }
  }
}
