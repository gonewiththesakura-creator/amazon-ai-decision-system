import type { AmazonDataCapability } from './types.js';
import { AdapterUnavailableError } from './types.js';

/**
 * V2.2 only establishes the server-side boundary for Amazon business data.
 * It deliberately contains no Ads, write, purchasing, or mock fallback path.
 */
export class AmazonDataAdapter {
  readonly id = 'source-amazon-data';
  readonly name = 'Amazon Business Data';
  readonly sourceType = 'amazon' as const;
  readonly capabilities: readonly AmazonDataCapability[] = [
    'OwnedProductCatalog', 'Orders', 'Sales', 'Traffic', 'Inventory',
  ];

  async fetchOwnedProductCatalog(): Promise<never> {
    throw new AdapterUnavailableError('Amazon Business Data 尚未配置；V2.2 不会回退到 Mock 数据。');
  }
}
