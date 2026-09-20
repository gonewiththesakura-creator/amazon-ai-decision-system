import { createHash, randomUUID } from 'node:crypto';
import { mcpToolSchema, type McpToolDefinition } from './sellersprite-mcp-schemas.js';
import type { McpCapabilitySnapshot, McpCapabilityStore } from './sellersprite-mcp-store.js';
import { isCredentialFieldName, redactCredentialAssignments } from './sensitive-field.js';

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
        description: tool.description ? REDACTED_SCHEMA_VALUE : undefined,
        inputSchema: safeInputSchema(tool.inputSchema),
        schemaHash: sellerSpriteSchemaHash(tool.inputSchema),
      })),
      capabilities: Object.fromEntries(
        [...this.mapping].map(([capability, tool]) => [capability, safeMetadataText(tool.name)]),
      ) as Partial<Record<SellerSpriteCapability, string>>,
      capabilitySchemaHashes: Object.fromEntries(
        [...this.mapping].map(([capability, tool]) => [
          capability, sellerSpriteSchemaHash(tool.inputSchema),
        ]),
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

export function sellerSpriteSchemaHash(schema: unknown): string {
  return createHash('sha256').update(canonicalJson(safeSchemaFingerprint(schema))).digest('hex');
}

const REDACTED_SCHEMA_VALUE = '[REDACTED]';
const PII_PATH = /asin|sku|e-?mail|phone|customer|account|user(?:name|id)?|person|address|postal|zip|(?:^|[_-])name(?:$|[_-])|title|keyword|query/i;
const SCHEMA_VALUE_KEY = /^(?:enum|const|default|examples?)$/i;
const SCHEMA_TEXT_KEY = /^(?:description|title|\$comment|pattern|\$ref|\$id|\$schema)$/i;
const SCHEMA_STRUCTURE_KEYS = new Set([
  'type', 'properties', 'required', 'items', 'additionalProperties', 'format',
  'oneOf', 'allOf', 'anyOf', '$defs', 'definitions',
]);
const JSON_SCHEMA_TYPES = new Set([
  'array', 'boolean', 'integer', 'null', 'number', 'object', 'string',
]);
const JSON_SCHEMA_FORMATS = new Set([
  'date', 'date-time', 'duration', 'email', 'hostname', 'idn-email', 'idn-hostname',
  'ipv4', 'ipv6', 'iri', 'iri-reference', 'json-pointer', 'regex',
  'relative-json-pointer', 'time', 'uri', 'uri-reference', 'uri-template', 'uuid',
]);
const MARKETPLACES = new Set([
  'AE', 'AU', 'BE', 'BR', 'CA', 'DE', 'EG', 'ES', 'FR', 'IN', 'IT', 'JP', 'MX',
  'NL', 'PL', 'SA', 'SE', 'SG', 'TR', 'UK', 'US',
]);
const SAFE_CONTRACT_ENUMS: Record<string, ReadonlySet<string>> = {
  marketplace: MARKETPLACES,
  period: new Set(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']),
  granularity: new Set(['day', 'week', 'month', 'quarter', 'year']),
  interval: new Set(['day', 'week', 'month', 'quarter', 'year']),
  frequency: new Set(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']),
  sortOrder: new Set(['asc', 'ascending', 'desc', 'descending']),
  order: new Set(['asc', 'ascending', 'desc', 'descending']),
  direction: new Set(['asc', 'ascending', 'desc', 'descending']),
};

interface SchemaFingerprintContext {
  keyword?: string;
  propertyName?: string;
}

function safeSchemaFingerprint(value: unknown, context: SchemaFingerprintContext = {}): unknown {
  if ((context.keyword && isSensitiveSchemaPath(context.keyword))
    || (context.propertyName && isSensitiveSchemaPath(context.propertyName))) {
    return REDACTED_SCHEMA_VALUE;
  }
  if (context.keyword && SCHEMA_VALUE_KEY.test(context.keyword)) {
    return safeContractSchemaValue(context.propertyName, value) ?? REDACTED_SCHEMA_VALUE;
  }
  if (context.keyword && SCHEMA_TEXT_KEY.test(context.keyword)) return REDACTED_SCHEMA_VALUE;
  if (context.keyword && !SCHEMA_STRUCTURE_KEYS.has(context.keyword)) return REDACTED_SCHEMA_VALUE;
  if (Array.isArray(value)) {
    const entries = value.map((entry) => safeSchemaFingerprint(entry, context));
    return context.keyword === 'required'
      ? entries.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
      : entries;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined);
    if (context.keyword === 'properties') {
      return entries.map(([propertyName, item]) => [
        safeSchemaPath(propertyName),
        safeSchemaFingerprint(item, { propertyName }),
      ]).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    }
    return Object.fromEntries(entries.map(([key, item]) => [
      safeSchemaPath(key),
      safeSchemaFingerprint(item, { keyword: key, propertyName: context.propertyName }),
    ]));
  }
  if (typeof value === 'string') {
    if (context.keyword === 'required') return safeSchemaPath(value);
    if (context.keyword === 'type' && JSON_SCHEMA_TYPES.has(value)) return value;
    if (context.keyword === 'format' && JSON_SCHEMA_FORMATS.has(value)) return value;
    return REDACTED_SCHEMA_VALUE;
  }
  return context.keyword === 'additionalProperties' && typeof value === 'boolean'
    ? value : REDACTED_SCHEMA_VALUE;
}

function safeContractSchemaValue(propertyName: string | undefined, value: unknown): unknown | null {
  if (!propertyName) return null;
  const allowlist = SAFE_CONTRACT_ENUMS[propertyName];
  if (!allowlist) return null;
  const normalize = (item: unknown): string | null => {
    if (typeof item !== 'string') return null;
    const candidate = propertyName === 'marketplace' ? item.toUpperCase() : item.toLowerCase();
    return allowlist.has(candidate) ? candidate : null;
  };
  if (Array.isArray(value)) {
    const normalized = value.map(normalize);
    return normalized.every((item): item is string => item !== null)
      ? [...new Set(normalized)].sort((left, right) => left.localeCompare(right))
      : null;
  }
  return normalize(value);
}

function safeSchemaPath(value: string): string {
  if (isCredentialFieldName(value)) return '[CREDENTIAL_PATH]';
  if (PII_PATH.test(value)) return '[PII_PATH]';
  return safeMetadataText(value);
}

function isSensitiveSchemaPath(value: string): boolean {
  return isCredentialFieldName(value) || PII_PATH.test(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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
  return /https?:\/\//i.test(value) || isCredentialFieldName(value)
    || redactCredentialAssignments(value) !== value
    ? '[REDACTED]' : value;
}

function safeInputSchema(schema: McpToolDefinition['inputSchema']): McpToolDefinition['inputSchema'] {
  return safeSchemaProperty(schema) as McpToolDefinition['inputSchema'];
}

function safeSchemaProperty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const safeKey = safeSchemaPath(key);
    if (isSensitiveSchemaPath(key)) return [safeKey, REDACTED_SCHEMA_VALUE];
    if (SCHEMA_VALUE_KEY.test(key) || !SCHEMA_STRUCTURE_KEYS.has(key)) return [safeKey, REDACTED_SCHEMA_VALUE];
    if (key === 'type') return [safeKey, typeof item === 'string' && JSON_SCHEMA_TYPES.has(item)
      ? item : REDACTED_SCHEMA_VALUE];
    if (key === 'format') return [safeKey, typeof item === 'string' && JSON_SCHEMA_FORMATS.has(item)
      ? item : REDACTED_SCHEMA_VALUE];
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [safeKey, REDACTED_SCHEMA_VALUE];
      return [safeKey, Object.fromEntries(Object.entries(item).map(([propertyName, property]) => [
        safeSchemaPath(propertyName), isSensitiveSchemaPath(propertyName)
          ? REDACTED_SCHEMA_VALUE : safeSchemaProperty(property),
      ]))];
    }
    if (Array.isArray(item)) return [safeKey, item.map((entry) => {
      if (typeof entry === 'string') return key === 'required' ? safeSchemaPath(entry) : REDACTED_SCHEMA_VALUE;
      if (entry && typeof entry === 'object') return safeSchemaProperty(entry);
      return REDACTED_SCHEMA_VALUE;
    })];
    if (item && typeof item === 'object') return [safeKey, safeSchemaProperty(item)];
    return [safeKey, key === 'additionalProperties' && typeof item === 'boolean'
      ? item : REDACTED_SCHEMA_VALUE];
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
