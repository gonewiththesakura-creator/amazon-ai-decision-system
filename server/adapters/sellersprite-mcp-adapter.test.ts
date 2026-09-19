import { describe, expect, it } from 'vitest';
import { SellerSpriteMCPAdapter } from './sellersprite-mcp-adapter.js';
import { SellerSpriteMcpClient, type SellerSpriteMcpTransport } from './sellersprite-mcp-client.js';

describe('SellerSpriteMCPAdapter', () => {
  it('uses discovered nested market tool arguments and retains absent statistics as absent', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const result = await adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: 'Home/Bed Pillows', month: '2026-08',
    });

    expect(transport.calls[0]).toEqual({
      name: 'market_research_statistics',
      arguments: { request: { marketplace: 'US', nodeIdPath: 'Home/Bed Pillows', month: '2026-08' } },
    });
    expect(result.data).toMatchObject({ products: 100, brands: 71, avgPrice: 44.83 });
    expect(result.data).not.toHaveProperty('totalUnits');
    expect(result.provenance).toMatchObject({ sourceType: 'mcp', isEstimated: true });
  });

  it('routes concentration, monthly ASIN trend, and competitor candidates through their discovered tools', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const concentration = await adapter.fetchMarketConcentration({ marketplace: 'US', nodeIdPath: 'Home/Bed Pillows' });
    const trend = await adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });
    const candidates = await adapter.discoverAsinCompetitors({ marketplace: 'US', asin: 'B000TEST01', size: 10 });

    expect(concentration.data).toHaveLength(2);
    expect(trend.data.salesTrendPoints).toEqual([
      { month: '2026-07', childUnitSales: 200, childSalesRevenue: 8_000 },
    ]);
    expect(candidates.data[0]).toMatchObject({ asin: 'B000TEST02' });
    expect(transport.calls.map((call) => call.name)).toEqual([
      'market_product_concentration', 'asin_sales_trend', 'asin_competitor',
    ]);
    expect(transport.calls.at(-1)?.arguments).toEqual({ marketplace: 'US', asin: 'B000TEST01', size: 10 });
  });

  it('rejects failed SellerSprite envelopes and missing legacy overview metrics without fabricating data', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    await expect(adapter.fetchMarketOverview({ marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows' }))
      .rejects.toThrow(/missing|缺失/i);

    transport.remoteCode = 'DENIED';
    await expect(adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toThrow(/rejected|失败/i);
  });

  it('fails closed with a configuration error when no server endpoint exists', async () => {
    const previous = process.env.SELLERSPRITE_MCP_URL;
    delete process.env.SELLERSPRITE_MCP_URL;
    try {
      const adapter = new SellerSpriteMCPAdapter();
      await expect(adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' }))
        .rejects.toThrow(/SELLERSPRITE_MCP_URL/);
    } finally {
      if (previous === undefined) delete process.env.SELLERSPRITE_MCP_URL;
      else process.env.SELLERSPRITE_MCP_URL = previous;
    }
  });

  it('normalizes monthly trend dates to month-end and rejects products without an observation date', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });
    expect(detail.latest.date).toBe('2026-07-31');

    transport.marketItems = [{ asin: 'B000TEST02', title: 'Undated product' }];
    await expect(adapter.fetchMarketProducts({ marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows' }))
      .rejects.toThrow(/observation|date/i);
  });
});

class AdapterTransport implements SellerSpriteMcpTransport {
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  remoteCode = 'OK';
  marketItems: Array<Record<string, unknown>> = [];

  async connect(): Promise<void> {}
  async ping(): Promise<unknown> { return { _meta: { progressToken: 'test' } }; }
  async close(): Promise<void> {}

  async listTools(): Promise<unknown> {
    return {
      tools: [
        tool('market_research_statistics', ['request'], { marketplace: {}, nodeIdPath: {} }),
        tool('market_product_concentration', ['request'], { marketplace: {}, nodeIdPath: {} }),
        tool('asin_sales_trend', ['marketplace', 'asin']),
        tool('asin_competitor', ['marketplace', 'asin']),
        tool('market_research', ['request'], { marketplace: {} }),
      ],
      _meta: { progressToken: 'test' },
    };
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    this.calls.push(params);
    const data: Record<string, unknown> = {
      market_research_statistics: {
        products: 100, brands: 71, sellers: 69, avgUnits: 8_919, avgRevenue: 398_295,
        avgPrice: 44.83, avgRating: 4.3,
      },
      market_product_concentration: [
        { asin: 'B000TEST01', totalUnitsRatio: 0.1, totalRevenueRatio: 0.12 },
        { asin: 'B000TEST02', totalUnitsRatio: 0.08, totalRevenueRatio: 0.09 },
      ],
      asin_sales_trend: {
        asin: { asin: 'B000TEST01', title: 'Test product', marketplace: 'US' },
        salesTrendPoints: [{ month: '2026-07', childUnitSales: 200, childSalesRevenue: 8_000 }],
      },
      asin_competitor: [{ asin: 'B000TEST02', title: 'Candidate', units: 300 }],
      market_research: { pages: 1, page: 1, size: 5, total: this.marketItems.length, items: this.marketItems, hasNextPage: false },
    };
    const payload = { code: this.remoteCode, message: this.remoteCode === 'OK' ? 'success' : 'denied', data: data[params.name] };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload), annotations: { audience: ['assistant'], priority: 1 } }],
      isError: false,
      _meta: { progressToken: 'test' },
    };
  }
}

function tool(name: string, required: string[], requestProperties?: Record<string, unknown>) {
  return {
    name,
    description: name.replaceAll('_', ' '),
    inputSchema: {
      type: 'object',
      required,
      properties: Object.fromEntries(required.map((field) => [field, field === 'request'
        ? { type: 'object', required: Object.keys(requestProperties ?? {}), properties: requestProperties }
        : { type: 'string' }])),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { provider: 'sellersprite' },
  };
}
