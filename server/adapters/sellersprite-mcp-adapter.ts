import type { Product } from '../../shared/types.js';
import type {
  KeywordDataRecord,
  KeywordInput,
  MarketDataAdapter,
  MarketInput,
  MarketOverviewRecord,
  ProductDetailRecord,
  ProductInput,
} from './types.js';
import { AdapterUnavailableError } from './types.js';

export class SellerSpriteMCPAdapter implements MarketDataAdapter {
  readonly id = 'source-sellersprite-mcp';
  readonly name = 'SellerSprite MCP';
  readonly sourceType = 'mcp' as const;

  private unavailable(): never {
    const configured = Boolean(process.env.SELLERSPRITE_MCP_URL);
    throw new AdapterUnavailableError(configured
      ? 'SellerSprite MCP 端点已配置，但当前版本仅保留适配器边界，需补充账号协议。'
      : '未配置 SELLERSPRITE_MCP_URL，请在服务端环境变量中设置。');
  }

  async fetchMarketOverview(input: MarketInput): Promise<MarketOverviewRecord> { void input; return this.unavailable(); }
  async fetchMarketProducts(input: MarketInput): Promise<Product[]> { void input; return this.unavailable(); }
  async fetchProductDetail(input: ProductInput): Promise<ProductDetailRecord> { void input; return this.unavailable(); }
  async fetchKeywordData(input: KeywordInput): Promise<KeywordDataRecord[]> { void input; return this.unavailable(); }
}
