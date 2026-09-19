import { describe, expect, it } from 'vitest';
import { AmazonDataAdapter } from './amazon-data-adapter.js';
import { AdapterUnavailableError } from './types.js';

describe('AmazonDataAdapter', () => {
  it('advertises the V2.2 read-only scopes and refuses unconfigured calls without mock data', async () => {
    const adapter = new AmazonDataAdapter();
    expect(adapter.capabilities).toEqual(['OwnedProductCatalog', 'Orders', 'Sales', 'Traffic', 'Inventory']);
    await expect(adapter.fetchOwnedProductCatalog()).rejects.toBeInstanceOf(AdapterUnavailableError);
  });
});
