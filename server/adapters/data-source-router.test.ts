import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './adapter-registry.js';
import { DataSourceRouter } from './data-source-router.js';

const baseInput = {
  taskType: 'market_refresh',
  marketplace: 'US',
} as const;

describe('DataSourceRouter', () => {
  const router = new DataSourceRouter(new AdapterRegistry());

  it('routes every supported demo refresh to the explicitly marked Mock adapter', () => {
    expect(router.resolve({ ...baseInput, mode: 'demo' })).toMatchObject({
      id: 'source-mock', sourceType: 'mock',
    });
    expect(router.resolve({
      ...baseInput,
      taskType: 'watchlist_refresh',
      entityType: 'competitor',
      sourcePreference: 'SellerSprite MCP',
      mode: 'demo',
    })).toMatchObject({ id: 'source-mock', sourceType: 'mock' });
  });

  it('routes live collection to SellerSprite without falling back to Mock', () => {
    for (const taskType of [
      'market_refresh', 'owned_sku_refresh', 'competitor_refresh',
      'keyword_refresh', 'review_refresh', 'dashboard_core_refresh', 'watchlist_refresh',
    ]) {
      expect(router.resolve({ ...baseInput, taskType, mode: 'live' })).toMatchObject({
        id: 'source-sellersprite-mcp', sourceType: 'mcp',
      });
    }
  });

  it('rejects an explicit Mock preference outside Demo mode', () => {
    expect(() => router.resolve({
      ...baseInput,
      mode: 'live',
      sourcePreference: 'Mock Adapter',
    })).toThrow(/Live 模式禁止使用 Mock Adapter/);
  });

  it('honors explicit real import routes without treating them as executable MCP calls', () => {
    expect(router.resolve({
      ...baseInput,
      taskType: 'file_import',
      sourcePreference: 'SellerSprite Import',
      mode: 'live',
    }).id).toBe('source-sellersprite-import');
    expect(router.resolve({
      ...baseInput,
      taskType: 'amazon_internal',
      mode: 'live',
    }).id).toBe('source-amazon-import');
  });

  it('fails closed for unsupported task types', () => {
    expect(() => router.resolve({
      ...baseInput,
      taskType: 'unknown_refresh',
      mode: 'live',
    })).toThrow(/暂不支持数据任务类型/);
  });
});
