import { AmazonImportAdapter, SellerSpriteImportAdapter } from './import-adapters.js';
import { MockAdapter } from './mock-adapter.js';
import { SellerSpriteMCPAdapter } from './sellersprite-mcp-adapter.js';
import type { FileDataAdapter, MarketDataAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, MarketDataAdapter>();

  constructor(adapters: MarketDataAdapter[] = [
    new MockAdapter(),
    new SellerSpriteImportAdapter(),
    new AmazonImportAdapter(),
    new SellerSpriteMCPAdapter(),
  ]) {
    adapters.forEach((adapter) => this.adapters.set(adapter.id, adapter));
  }

  get(id: string): MarketDataAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown data source adapter: ${id}`);
    return adapter;
  }

  getFile(id: string): FileDataAdapter {
    const adapter = this.get(id);
    if (!('ingest' in adapter) || typeof adapter.ingest !== 'function') {
      throw new Error(`Data source adapter does not support file ingest: ${id}`);
    }
    return adapter as FileDataAdapter;
  }

  list(): MarketDataAdapter[] {
    return [...this.adapters.values()];
  }
}

export * from './types.js';
export * from './mock-adapter.js';
export * from './import-adapters.js';
export * from './sellersprite-mcp-adapter.js';
export * from './manual-input-adapter.js';
