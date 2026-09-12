import type { DataMode } from '../../shared/types.js';
import { AdapterRegistry } from './adapter-registry.js';
import type { MarketDataAdapter } from './types.js';

export interface DataSourceRouteInput {
  taskType: string;
  entityType?: string;
  sourcePreference?: string;
  marketplace: string;
  mode: DataMode;
}

const DEMO_ADAPTER_ID = 'source-mock';
const SELLERSPRITE_MCP_ADAPTER_ID = 'source-sellersprite-mcp';
const SELLERSPRITE_IMPORT_ADAPTER_ID = 'source-sellersprite-import';
const AMAZON_IMPORT_ADAPTER_ID = 'source-amazon-import';

const SUPPORTED_REFRESH_TASKS = new Set([
  'manual_refresh',
  'dashboard_core_refresh',
  'market_refresh',
  'owned_sku_refresh',
  'product_refresh',
  'competitor_refresh',
  'keyword_refresh',
  'review_refresh',
  'watchlist_refresh',
  'development_research',
  'development_market_research',
  'opportunity_research',
  'amazon_internal',
  'file_import',
]);

/** Selects one explicit adapter before a refresh is allowed to touch persistence. */
export class DataSourceRouter {
  constructor(private readonly registry: Pick<AdapterRegistry, 'get' | 'list'> = new AdapterRegistry()) {}

  resolve(input: DataSourceRouteInput): MarketDataAdapter {
    const taskType = input.taskType.trim().toLowerCase();
    if (!SUPPORTED_REFRESH_TASKS.has(taskType)) {
      throw new Error(`暂不支持数据任务类型：${input.taskType}。`);
    }

    if (input.mode === 'demo') return this.registry.get(DEMO_ADAPTER_ID);

    const preferred = this.preferredAdapter(input.sourcePreference);
    const adapterId = preferred ?? this.defaultAdapterId(taskType, input.entityType);
    const adapter = this.registry.get(adapterId);
    if (adapter.sourceType === 'mock') {
      throw new Error('Live 模式禁止使用 Mock Adapter；当前任务没有可用真实数据源，请先配置数据源。');
    }
    return adapter;
  }

  private preferredAdapter(sourcePreference: string | undefined): string | null {
    if (!sourcePreference || isAutomaticPreference(sourcePreference)) return null;
    const normalized = normalize(sourcePreference);
    const exact = this.registry.list().find((adapter) => (
      normalize(adapter.id) === normalized || normalize(adapter.name) === normalized
    ));
    if (exact) return exact.id;
    if (normalized.includes('mock')) return DEMO_ADAPTER_ID;
    if (normalized.includes('amazon')) return AMAZON_IMPORT_ADAPTER_ID;
    if (normalized.includes('import') && normalized.includes('seller')) return SELLERSPRITE_IMPORT_ADAPTER_ID;
    if (normalized.includes('seller') || normalized === 'mcp') return SELLERSPRITE_MCP_ADAPTER_ID;
    throw new Error(`无法识别数据源偏好：${sourcePreference}。`);
  }

  private defaultAdapterId(taskType: string, entityType: string | undefined): string {
    if (taskType === 'amazon_internal') return AMAZON_IMPORT_ADAPTER_ID;
    if (taskType === 'file_import') {
      return normalize(entityType ?? '').includes('amazon')
        ? AMAZON_IMPORT_ADAPTER_ID
        : SELLERSPRITE_IMPORT_ADAPTER_ID;
    }
    return SELLERSPRITE_MCP_ADAPTER_ID;
  }
}

function isAutomaticPreference(value: string): boolean {
  return /^(configured[\s_-]?adapter|data[\s_-]?source[\s_-]?router|auto)$/i.test(value.trim());
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}
