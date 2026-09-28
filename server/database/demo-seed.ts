import type { Evidence, Insight, ScoreBreakdown } from '../../shared/types.js';
import { calculateOpportunityScore, opportunityStatus } from '../domain/calculations.js';
import type { AppDatabase } from './database.js';
import { transaction } from './database.js';

const DEMO_NOW = '2026-09-09T10:20:00+08:00';
const DEMO_SOURCE = '演示数据 / Mock Adapter';
const DEMO_SEED_ID = 'v2-demo-seed';

const marketNodes = [
  ['mkt-pillow', 'Pillow', null, 1, ['pillow'], '已监控', 69, 70],
  ['mkt-memory-foam', 'Memory Foam Pillow', 'mkt-pillow', 2, ['memory foam pillow', 'memory pillow'], '值得研究', 67, 78],
  ['mkt-cervical', 'Cervical Pillow', 'mkt-memory-foam', 3, ['cervical pillow', 'neck pain pillow'], '高增长', 65, 82],
  ['mkt-contour', 'Contour Pillow', 'mkt-memory-foam', 3, ['contour pillow'], '稳定', 73, 69],
  ['mkt-ergonomic', 'Ergonomic Pillow', 'mkt-memory-foam', 3, ['ergonomic pillow'], '值得研究', 63, 80],
  ['mkt-neck-support', 'Neck Support Pillow', 'mkt-memory-foam', 3, ['neck support pillow'], '高增长', 70, 76],
  ['mkt-side-sleeper', 'Side Sleeper Pillow', 'mkt-memory-foam', 3, ['side sleeper pillow'], '稳定', 76, 65],
  ['mkt-back-sleeper', 'Back Sleeper Pillow', 'mkt-memory-foam', 3, ['back sleeper pillow'], '观察', 58, 73],
  ['mkt-other-memory', '其他高相关记忆棉枕', 'mkt-memory-foam', 3, ['adjustable memory foam pillow'], '观察', 62, 67],
  ['mkt-lumbar', 'Memory Foam Lumbar Pillow', null, 1, ['lumbar pillow', 'memory foam back support'], '值得研究', 54, 84],
  ['mkt-travel', 'Memory Foam Travel Pillow', null, 1, ['travel pillow', 'u shaped pillow'], '验证中', 64, 71],
  ['mkt-seat-cushion', 'Memory Foam Seat Cushion', null, 1, ['seat cushion', 'office chair cushion'], '观察', 78, 62],
] as const;

const mainPriceBands = [
  { label: '< $20', productCount: 184, monthlySales: 15_420, revenue: 275_930, avgReviews: 412, newProducts: 28, growth: -2.4 },
  { label: '$20–29', productCount: 306, monthlySales: 31_850, revenue: 804_380, avgReviews: 738, newProducts: 44, growth: 4.8 },
  { label: '$30–39', productCount: 285, monthlySales: 39_610, revenue: 1_365_410, avgReviews: 895, newProducts: 52, growth: 11.7 },
  { label: '$40–49', productCount: 189, monthlySales: 24_740, revenue: 1_102_560, avgReviews: 1_204, newProducts: 31, growth: 9.1 },
  { label: '$50–69', productCount: 121, monthlySales: 12_130, revenue: 704_620, avgReviews: 1_680, newProducts: 13, growth: 5.3 },
  { label: '≥ $70', productCount: 43, monthlySales: 4_467, revenue: 356_904, avgReviews: 2_110, newProducts: 4, growth: -1.8 },
];

const mainConcentration = [
  { tier: 'TOP10', share: 26.8, avgPrice: 43.2, avgSales: 3_436 },
  { tier: 'TOP20', share: 41.5, avgPrice: 41.7, avgSales: 2_660 },
  { tier: 'TOP50', share: 66.2, avgPrice: 38.9, avgSales: 1_697 },
  { tier: 'TOP100', share: 81.4, avgPrice: 36.8, avgSales: 1_044 },
];

const mainMarketSnapshots = [
  ['2026-04-12', 982, 716, 388, 104_900, 3_470_000, 33.08, 31.99, 4.29, 703],
  ['2026-05-12', 1_006, 728, 397, 108_400, 3_620_000, 33.39, 32.49, 4.30, 721],
  ['2026-06-11', 1_031, 741, 404, 111_900, 3_790_000, 33.87, 32.99, 4.31, 746],
  ['2026-07-11', 1_067, 759, 416, 114_200, 3_920_000, 34.33, 33.49, 4.31, 769],
  ['2026-08-10', 1_094, 781, 429, 118_500, 4_105_000, 34.64, 33.99, 4.32, 792],
  ['2026-09-09', 1_128, 803, 441, 128_217, 4_609_804, 35.95, 34.99, 4.33, 815],
] as const;

const childMarketCurrent = [
  ['mkt-pillow', 2_674, 1_911, 1_018, 298_400, 8_620_000, 28.89, 26.99, 4.30, 612, 3.6],
  ['mkt-cervical', 214, 158, 92, 29_430, 1_128_360, 38.34, 36.99, 4.34, 646, 15.6],
  ['mkt-contour', 198, 143, 88, 21_670, 792_810, 36.59, 34.99, 4.31, 1_148, 3.2],
  ['mkt-ergonomic', 167, 122, 76, 24_920, 946_960, 38.00, 37.49, 4.36, 731, 12.4],
  ['mkt-neck-support', 152, 110, 70, 18_830, 753_012, 39.99, 38.99, 4.32, 904, 9.8],
  ['mkt-side-sleeper', 145, 107, 62, 14_640, 542_774, 37.08, 35.99, 4.30, 1_276, 5.1],
  ['mkt-back-sleeper', 111, 81, 49, 10_730, 351_300, 32.74, 31.99, 4.28, 512, 7.6],
  ['mkt-other-memory', 141, 96, 61, 8_027, 294_588, 36.70, 34.99, 4.27, 433, -1.5],
  ['mkt-lumbar', 362, 244, 129, 41_850, 1_365_408, 32.63, 31.99, 4.35, 486, 18.4],
  ['mkt-travel', 428, 301, 151, 48_210, 1_253_460, 26.00, 24.99, 4.28, 1_033, 6.8],
  ['mkt-seat-cushion', 735, 504, 266, 76_300, 2_516_137, 32.98, 31.99, 4.31, 1_428, 2.6],
] as const;

interface DemoProduct {
  id: string;
  asin: string;
  sku?: string;
  internalName?: string;
  brand: string;
  title: string;
  imageUrl: string;
  productType: string;
  owned: boolean;
  marketNodeId: string;
  keywords: string[];
  monitoring: boolean;
  snapshots: Array<{
    date: string;
    price: number;
    rating: number;
    reviews: number;
    bsr: number;
    sales: number;
    growth7d: number;
    growth30d: number;
    growth90d: number;
  }>;
}

const demoProducts: DemoProduct[] = [
  {
    id: 'owned-sku-01', asin: 'B0DEMO0001', sku: 'MF-ERG-01', internalName: '云感护颈枕', brand: 'Nuvora',
    title: 'Nuvora Ergonomic Memory Foam Cervical Pillow', imageUrl: 'https://images.unsplash.com/photo-1636967665863-b48872cc6d01?auto=format&fit=crop&w=800&q=80',
    productType: 'ergonomic_pillow', owned: true, marketNodeId: 'mkt-ergonomic', keywords: ['ergonomic pillow', 'cervical pillow'], monitoring: true,
    snapshots: [
      { date: '2026-06-11', price: 39.99, rating: 4.3, reviews: 928, bsr: 8_960, sales: 1_830, growth7d: 2.1, growth30d: 4.2, growth90d: 8.9 },
      { date: '2026-07-11', price: 39.99, rating: 4.3, reviews: 974, bsr: 8_720, sales: 1_910, growth7d: 1.7, growth30d: 4.4, growth90d: 9.4 },
      { date: '2026-08-10', price: 39.99, rating: 4.3, reviews: 1_019, bsr: 8_510, sales: 2_005, growth7d: 1.2, growth30d: 5.0, growth90d: 10.7 },
      { date: '2026-09-09', price: 39.99, rating: 4.3, reviews: 1_063, bsr: 8_630, sales: 2_021, growth7d: -1.4, growth30d: 0.8, growth90d: 10.4 },
    ],
  },
  {
    id: 'owned-sku-02', asin: 'B0DEMO0002', sku: 'MF-CER-02', internalName: '深眠蝶翼枕', brand: 'Nuvora',
    title: 'Nuvora Butterfly Cervical Memory Foam Pillow', imageUrl: 'https://images.unsplash.com/photo-1547104442-044448b73426?auto=format&fit=crop&w=800&q=80',
    productType: 'cervical_pillow', owned: true, marketNodeId: 'mkt-cervical', keywords: ['butterfly cervical pillow', 'neck pain pillow'], monitoring: true,
    snapshots: [
      { date: '2026-06-11', price: 45.99, rating: 4.5, reviews: 612, bsr: 7_880, sales: 2_120, growth7d: 4.2, growth30d: 7.5, growth90d: 13.1 },
      { date: '2026-07-11', price: 45.99, rating: 4.5, reviews: 668, bsr: 7_210, sales: 2_286, growth7d: 5.5, growth30d: 7.8, growth90d: 14.8 },
      { date: '2026-08-10', price: 45.99, rating: 4.5, reviews: 731, bsr: 6_540, sales: 2_410, growth7d: 3.8, growth30d: 5.4, growth90d: 16.2 },
      { date: '2026-09-09', price: 45.99, rating: 4.5, reviews: 812, bsr: 4_980, sales: 2_865, growth7d: 6.7, growth30d: 18.9, growth90d: 35.1 },
    ],
  },
  {
    id: 'owned-sku-03', asin: 'B0DEMO0003', sku: 'MF-CON-03', internalName: '舒压波浪枕', brand: 'Nuvora',
    title: 'Nuvora Contour Memory Foam Pillow for Side Sleepers', imageUrl: 'https://images.unsplash.com/photo-1636967665863-b48872cc6d01?auto=format&fit=crop&w=800&q=80',
    productType: 'contour_pillow', owned: true, marketNodeId: 'mkt-contour', keywords: ['contour pillow', 'side sleeper pillow'], monitoring: true,
    snapshots: [
      { date: '2026-06-11', price: 32.99, rating: 4.2, reviews: 1_441, bsr: 10_420, sales: 1_720, growth7d: 0.8, growth30d: 2.2, growth90d: 4.1 },
      { date: '2026-07-11', price: 32.99, rating: 4.2, reviews: 1_487, bsr: 10_810, sales: 1_665, growth7d: -1.9, growth30d: -3.2, growth90d: 0.7 },
      { date: '2026-08-10', price: 32.99, rating: 4.2, reviews: 1_526, bsr: 11_130, sales: 1_610, growth7d: -2.8, growth30d: -3.3, growth90d: -6.4 },
      { date: '2026-09-09', price: 32.99, rating: 4.2, reviews: 1_557, bsr: 12_780, sales: 1_520, growth7d: -7.2, growth30d: -5.6, growth90d: -11.6 },
    ],
  },
  {
    id: 'owned-sku-04', asin: 'B0DEMO0004', sku: 'MF-SIDE-04', internalName: '高低双面枕', brand: 'Nuvora',
    title: 'Nuvora Dual Height Memory Foam Pillow', imageUrl: 'https://images.unsplash.com/photo-1547104442-044448b73426?auto=format&fit=crop&w=800&q=80',
    productType: 'side_sleeper_pillow', owned: true, marketNodeId: 'mkt-side-sleeper', keywords: ['dual height pillow', 'side sleeper pillow'], monitoring: true,
    snapshots: [
      { date: '2026-06-11', price: 42.99, rating: 4.4, reviews: 488, bsr: 9_240, sales: 1_540, growth7d: 2.9, growth30d: 5.4, growth90d: 11.8 },
      { date: '2026-07-11', price: 42.99, rating: 4.4, reviews: 531, bsr: 8_890, sales: 1_628, growth7d: 3.1, growth30d: 5.7, growth90d: 12.6 },
      { date: '2026-08-10', price: 42.99, rating: 4.4, reviews: 579, bsr: 8_380, sales: 1_710, growth7d: 2.6, growth30d: 5.0, growth90d: 11.0 },
      { date: '2026-09-09', price: 42.99, rating: 4.4, reviews: 638, bsr: 7_790, sales: 1_879, growth7d: 2.1, growth30d: 9.9, growth90d: 22.0 },
    ],
  },
  ...buildCompetitorProducts(),
];

function buildCompetitorProducts(): DemoProduct[] {
  const definitions = [
    ['competitor-01', 'B0DEMO1001', 'SleepNova', 'Adjustable Cervical Pillow', 'mkt-cervical', 37.99, 4.4, 3_820, 3_650, 14.2, 84],
    ['competitor-02', 'B0DEMO1002', 'RestPeak', 'Contour Orthopedic Pillow', 'mkt-contour', 29.99, 4.3, 8_430, 4_920, 5.4, 90],
    ['competitor-03', 'B0DEMO1003', 'ErgoCloud', 'Premium Ergonomic Neck Pillow', 'mkt-ergonomic', 64.99, 4.6, 6_180, 3_110, 8.7, 82],
    ['competitor-04', 'B0DEMO1004', 'DreamArc', 'Memory Foam Pillow for Neck Pain', 'mkt-neck-support', 34.99, 4.2, 1_220, 2_980, 31.5, 79],
    ['competitor-05', 'B0DEMO1005', 'CalmRest', 'Side Sleeper Memory Foam Pillow', 'mkt-side-sleeper', 39.99, 4.5, 2_760, 2_540, 11.8, 81],
    ['competitor-06', 'B0DEMO1006', 'ValueSleep', 'Cooling Contour Foam Pillow', 'mkt-contour', 22.99, 4.1, 980, 4_130, 22.7, 76],
    ['competitor-07', 'B0DEMO1007', 'AlignPro', 'Butterfly Cervical Pillow', 'mkt-cervical', 48.99, 4.6, 5_420, 3_880, 17.4, 92],
    ['competitor-08', 'B0DEMO1008', 'NewRest', 'New Release Ergonomic Memory Pillow', 'mkt-ergonomic', 35.99, 4.4, 286, 1_940, 58.2, 73],
  ] as const;

  return definitions.map((definition, index) => {
    const [id, asin, brand, title, marketNodeId, price, rating, reviews, sales, growth30d] = definition;
    return ({
    id,
    asin,
    brand,
    title,
    imageUrl: index % 2 === 0
      ? 'https://images.unsplash.com/photo-1636967665863-b48872cc6d01?auto=format&fit=crop&w=800&q=80'
      : 'https://images.unsplash.com/photo-1547104442-044448b73426?auto=format&fit=crop&w=800&q=80',
    productType: 'memory_foam_pillow',
    owned: false,
    marketNodeId,
    keywords: [],
    monitoring: index === 3 || index === 7,
    snapshots: [
      { date: '2026-08-10', price: Math.round(price * (index === 5 ? 1.12 : 1) * 100) / 100, rating, reviews: Math.max(1, reviews - 80), bsr: 10_000 - index * 510, sales: Math.round(sales / (1 + growth30d / 100)), growth7d: growth30d / 4, growth30d: growth30d / 2, growth90d: growth30d },
      { date: '2026-09-09', price, rating, reviews, bsr: 9_400 - index * 620, sales, growth7d: Math.round(growth30d / 4 * 10) / 10, growth30d, growth90d: Math.round(growth30d * 1.8 * 10) / 10 },
    ],
    });
  });
}

function demoEvidence(id: string, claim: string, metrics: Evidence['metrics']): Evidence {
  return {
    id,
    claim,
    metrics,
    provenance: [{
      source: DEMO_SOURCE,
      sourceType: 'mock',
      collectedAt: DEMO_NOW,
      period: '30D',
      isEstimated: true,
      confidence: 0.91,
    }],
  };
}

function insight(input: Omit<Insight, 'model' | 'dataVersion' | 'generatedAt'>): Insight {
  return {
    ...input,
    model: 'rule-engine-v1',
    dataVersion: 'demo-2026-09-09',
    generatedAt: DEMO_NOW,
  };
}

const demoInsights: Insight[] = [
  insight({
    id: 'insight-market-memory', entityType: 'market', entityId: 'mkt-memory-foam', insightType: 'market_analysis',
    status: '值得研究', title: '记忆棉枕市场仍在增长，人体工学细分更强',
    summary: '过去 30 天市场销量增长 8.2%，销售额增长快于销量，$30–49 价格带和人体工学细分是主要增量。',
    score: 78,
    facts: ['30D 销量 +8.2%', '市场月销售额 $4.61M', 'TOP20 销量占比 41.5%'],
    opportunities: ['$30–49 价格带增长 9.1%', 'Cervical 和 Ergonomic 细分增长领先'],
    risks: ['新品进入速度提升', '现有 SKU-01 未跟上所属细分'],
    recommendedActions: ['优先排查 SKU-01 转化与流量问题', '深入研究腰靠与护颈枕邻近机会'],
    evidence: [demoEvidence('ev-market-growth', '记忆棉枕市场 30D 增长 8.2%', [
      { name: 'monthly_sales_current', label: '当前月销量', value: 128_217 },
      { name: 'monthly_sales_previous', label: '30 天前月销量', value: 118_500 },
      { name: 'market_30d_growth', label: '30D 增长', value: 8.2, unit: '%' },
    ])],
    confidence: 0.91,
  }),
  buildSkuInsight('owned-sku-01', 'SKU-01', 0.8, 12.4, '明显跑输', '所属人体工学细分市场明显增长，但 SKU 基本停滞。'),
  buildSkuInsight('owned-sku-02', 'SKU-02', 18.9, 15.6, '轻度跑赢', '销量和 BSR 同步改善，跑赢所属护颈枕细分。'),
  buildSkuInsight('owned-sku-03', 'SKU-03', -5.6, 3.2, '轻度跑输', '市场仍有小幅增长，SKU 连续下降，需立即处理。'),
  buildSkuInsight('owned-sku-04', 'SKU-04', 9.9, 5.1, '轻度跑赢', '当前增长稳健，略高于所属侧睡细分。'),
  buildDevelopmentInsight('insight-dev-lumbar', 'dev-lumbar', '待 V2 工作流审批', 84, '腰靠与现有记忆棉工艺匹配，市场 90D 增长突出。'),
  buildDevelopmentInsight('insight-dev-travel', 'dev-travel', '待 V2 工作流审批', 71, '旅行枕需求稳定，但头部 Review 门槛较高。'),
  buildDevelopmentInsight('insight-dev-seat', 'dev-seat', '继续观察', 62, '坐垫市场足够大，但竞争和同质化风险偏高。'),
];

function buildSkuInsight(
  entityId: string,
  label: string,
  skuGrowth: number,
  marketGrowth: number,
  status: string,
  summary: string,
): Insight {
  const delta = Math.round((skuGrowth - marketGrowth) * 10) / 10;
  return insight({
    id: `insight-${entityId}`, entityType: 'owned_product', entityId, insightType: 'sku_diagnosis',
    status, title: `${label} ${status}`, summary, score: undefined,
    facts: [`SKU 30D ${skuGrowth >= 0 ? '+' : ''}${skuGrowth}%`, `所属市场 30D +${marketGrowth}%`, `相对差 ${delta >= 0 ? '+' : ''}${delta}%`],
    opportunities: delta >= 3 ? ['当前产品定位获得市场验证'] : [],
    risks: delta < -3 ? ['增长落后于所属市场'] : [],
    recommendedActions: delta < -3 ? ['比对直接竞品近 30 天价格与评论变化', '排查流量、转化与库存'] : ['保持监控并验证当前增长来源'],
    evidence: [demoEvidence(`ev-${entityId}`, `${label} 相对市场表现为 ${delta}%`, [
      { name: 'sku_30d_growth', label: 'SKU 30D 增长', value: skuGrowth, unit: '%' },
      { name: 'market_30d_growth', label: '市场 30D 增长', value: marketGrowth, unit: '%' },
      { name: 'relative_delta', label: '相对差', value: delta, unit: '%' },
    ])],
    confidence: 0.89,
  });
}

function buildDevelopmentInsight(id: string, entityId: string, status: string, score: number, summary: string): Insight {
  return insight({
    id, entityType: 'development_project', entityId, insightType: 'development_analysis', status,
    title: `${status}：${summary.split('，')[0]}`, summary, score,
    facts: [`机会评分 ${score}/100`, '供应链复用程度已纳入评估'],
    opportunities: ['可复用现有记忆棉供应链'],
    risks: score < 70 ? ['竞争或新品友好度仍需验证'] : ['演示数据需用真实导入复核'],
    recommendedActions: score >= 65
      ? ['创建 V2 Research Job，完成 Hard Gate、Reverse Review 和人工 Approval。']
      : ['保持观察并补充 TOP100 数据'],
    evidence: [demoEvidence(`ev-${entityId}`, `综合机会评分为 ${score}`, [{ name: 'opportunity_score', label: '机会评分', value: score }])],
    confidence: 0.84,
  });
}

const scoreBreakdowns: Record<string, ScoreBreakdown> = {
  'dev-lumbar': { demand: 17, growth: 19, competition: 16, newProductFriendly: 13, priceRoom: 8, concentration: 7, confidence: 4 },
  'dev-travel': { demand: 16, growth: 12, competition: 12, newProductFriendly: 10, priceRoom: 8, concentration: 9, confidence: 4 },
  'dev-seat': { demand: 18, growth: 8, competition: 8, newProductFriendly: 9, priceRoom: 7, concentration: 8, confidence: 4 },
};

export function clearBusinessData(database: AppDatabase): void {
  const tables = [
    'demo_seed_records',
    'import_batches', 'decisions', 'research_jobs', 'development_projects', 'watchlist_items', 'research_results',
    'opportunities', 'competitor_relations', 'product_snapshots', 'products', 'market_snapshots',
    'ai_insights', 'data_tasks', 'market_nodes',
  ];
  for (const table of tables) database.exec(`DELETE FROM ${table}`);
}

export function disableDemoMode(database: AppDatabase): void {
  transaction(database, () => {
    const settings = database.prepare('SELECT mode FROM app_settings WHERE id = 1').get() as { mode: string } | undefined;
    if (settings?.mode !== 'demo') return;
    const pending = database.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM demo_seed_records WHERE seed_id = ?
        UNION ALL SELECT 1 FROM market_snapshots WHERE source_type = 'mock'
        UNION ALL SELECT 1 FROM product_snapshots WHERE source_type = 'mock'
      ) AS found
    `).get(DEMO_SEED_ID) as { found: number };
    if (pending.found === 1) {
      throw new Error('请先完成 Go Live 迁移中的备份与 Demo 清理，不能直接关闭 Demo 模式。');
    }
    database.prepare(`
      UPDATE app_settings SET mode = 'empty', last_successful_sync = NULL WHERE id = 1
    `).run();
  });
}

export function resetWorkspaceData(database: AppDatabase): void {
  transaction(database, () => {
    clearBusinessData(database);
    database.prepare(`
      UPDATE app_settings SET mode = 'empty', default_market_id = '', last_successful_sync = NULL
      WHERE id = 1
    `).run();
    database.prepare('UPDATE data_sources SET last_sync_at = NULL').run();
  });
}

function hasNonDemoBusinessData(database: AppDatabase): boolean {
  return businessTables.some((table) => {
    const row = database.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM ${table} item
        WHERE NOT EXISTS (
          SELECT 1 FROM demo_seed_records seed
          WHERE seed.seed_id = ? AND seed.table_name = ? AND seed.record_id = item.id
        )
      ) AS found
    `).get(DEMO_SEED_ID, table) as { found: number };
    return row.found === 1;
  });
}

export function seedDemoData(database: AppDatabase): void {
  transaction(database, () => {
    const settings = database.prepare('SELECT mode FROM app_settings WHERE id = 1').get() as { mode: string } | undefined;
    const seeded = database.prepare(`
      SELECT EXISTS(SELECT 1 FROM demo_seed_records WHERE seed_id = ? LIMIT 1) AS found
    `).get(DEMO_SEED_ID) as { found: number };
    if (settings?.mode === 'demo' && seeded.found === 1) return;
    if (settings?.mode === 'demo' ? hasNonDemoBusinessData(database) : hasBusinessData(database)) {
      throw new Error('当前已有真实或导入数据，不能进入 Demo 模式。请保留现有数据并使用真实模式。');
    }
    insertMarkets(database);
    insertProducts(database);
    insertRelations(database);
    insertInsights(database);
    insertGrowthData(database);
    registerDemoSeedRecords(database);
    database.prepare(`
      UPDATE app_settings
      SET mode = 'demo', marketplace = 'US', currency = 'USD', default_market_id = 'mkt-memory-foam',
          ai_model = 'rule-engine-v1', last_successful_sync = ?
      WHERE id = 1
    `).run(DEMO_NOW);
    database.prepare(`UPDATE data_sources SET last_sync_at = ? WHERE id = 'source-mock'`).run(DEMO_NOW);
  });
}

function registerDemoSeedRecords(database: AppDatabase): void {
  const registered: Array<[string, string[]]> = [
    ['market_nodes', marketNodes.map(([id]) => id)],
    ['products', demoProducts.map((product) => product.id)],
    ['market_snapshots', [
      ...mainMarketSnapshots.map(([date]) => `ms-mfm-${date}`),
      ...childMarketCurrent.flatMap(([id]) => [`ms-${id}-prev`, `ms-${id}-current`]),
    ]],
    ['product_snapshots', demoProducts.flatMap((product) =>
      product.snapshots.map((_, index) => `ps-${product.id}-${index + 1}`))],
    ['competitor_relations', Array.from({ length: 12 }, (_, index) => `relation-${index + 1}`)],
    ['ai_insights', demoInsights.map((item) => item.id)],
    ['development_projects', ['dev-lumbar', 'dev-travel', 'dev-seat']],
    ['opportunities', ['opp-school-kit', 'opp-travel-desk', 'opp-cooling-lumbar']],
    ['research_results', ['research-demo-school']],
    ['watchlist_items', ['watch-market', 'watch-sku03', 'watch-comp04', 'watch-lumbar']],
    ['data_tasks', ['task-demo-1', 'task-demo-2', 'task-demo-3']],
  ];
  const insert = database.prepare(`
    INSERT INTO demo_seed_records (seed_id, table_name, record_id, created_at) VALUES (?, ?, ?, ?)
  `);
  for (const [tableName, ids] of registered) {
    for (const id of ids) insert.run(DEMO_SEED_ID, tableName, id, DEMO_NOW);
  }
}

const businessTables = [
  'market_nodes', 'market_snapshots', 'products', 'product_snapshots',
  'competitor_relations', 'ai_insights', 'development_projects', 'decisions',
  'opportunities', 'research_results', 'watchlist_items', 'data_tasks', 'import_batches',
  'research_jobs', 'research_steps', 'normalized_records', 'keywords',
  'keyword_snapshots', 'reviews', 'review_insights', 'missing_data_items',
  'evidence_records', 'rule_executions', 'score_results', 'reverse_reviews',
  'approvals', 'variation_families', 'competitor_candidates', 'metric_facts',
] as const;

function hasBusinessData(database: AppDatabase): boolean {
  return businessTables.some((table) => {
    const row = database.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS found`).get() as { found: number };
    return row.found === 1;
  });
}

function insertMarkets(database: AppDatabase): void {
  const nodeStatement = database.prepare(`
    INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, category_id, keywords_json, status,
      competition_score, opportunity_score, source_type, created_at
    ) VALUES (?, ?, ?, ?, 'US', NULL, ?, ?, ?, ?, 'mock', ?)
  `);
  for (const [id, name, parentId, level, keywords, status, competition, opportunity] of marketNodes) {
    nodeStatement.run(id, name, parentId, level, JSON.stringify(keywords), status, competition, opportunity, DEMO_NOW);
  }

  const snapshotStatement = database.prepare(`
    INSERT INTO market_snapshots (
      id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
      monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
      top20_share, new_product_share, price_bands_json, concentration_json, source,
      source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock', ?, '30D', 1, 0.91, ?, ?)
  `);

  for (const snapshot of mainMarketSnapshots) {
    const [date, productCount, sellerCount, brandCount, sales, revenue, avgPrice, medianPrice, rating, reviews] = snapshot;
    snapshotStatement.run(
      `ms-mfm-${date}`, 'mkt-memory-foam', date, productCount, sellerCount, brandCount,
      sales, revenue, avgPrice, medianPrice, rating, reviews, 26.8, 41.5, 16.1,
      JSON.stringify(mainPriceBands), JSON.stringify(mainConcentration), DEMO_SOURCE,
      `${date}T10:20:00+08:00`, date, `market|US|mkt-memory-foam|${date}|mock|${DEMO_SOURCE.trim().toLowerCase()}|30D`,
    );
  }

  for (const [id, productCount, sellerCount, brandCount, sales, revenue, avgPrice, medianPrice, rating, reviews, growth] of childMarketCurrent) {
    const previousSales = Math.round(sales / (1 + growth / 100));
    const currentDate = '2026-09-09';
    const previousDate = '2026-08-10';
    snapshotStatement.run(
      `ms-${id}-prev`, id, previousDate, Math.max(1, productCount - 4), sellerCount, brandCount,
      previousSales, Math.round(previousSales * avgPrice), avgPrice, medianPrice, rating, Math.max(0, reviews - 20),
      24.5, 39.2, 14.0, '[]', '[]', DEMO_SOURCE, `${previousDate}T10:20:00+08:00`, previousDate, `market|US|${id}|${previousDate}|mock|${DEMO_SOURCE.trim().toLowerCase()}|30D`,
    );
    snapshotStatement.run(
      `ms-${id}-current`, id, currentDate, productCount, sellerCount, brandCount,
      sales, revenue, avgPrice, medianPrice, rating, reviews, 24.5, 39.2, 14.0,
      '[]', '[]', DEMO_SOURCE, `${currentDate}T10:20:00+08:00`, currentDate, `market|US|${id}|${currentDate}|mock|${DEMO_SOURCE.trim().toLowerCase()}|30D`,
    );
  }
}

function insertProducts(database: AppDatabase): void {
  const productStatement = database.prepare(`
    INSERT INTO products (
      id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type,
      is_owned, market_node_id, keywords_json, monitoring_enabled, source_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'US', ?, ?, ?, ?, ?, 'mock', ?)
  `);
  const snapshotStatement = database.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d, source,
      source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'mock', ?, '30D', 1, 0.88, ?, ?)
  `);

  for (const product of demoProducts) {
    productStatement.run(
      product.id, product.asin, product.sku ?? null, product.internalName ?? null, product.brand,
      product.title, product.imageUrl, product.productType, product.owned ? 1 : 0,
      product.marketNodeId, JSON.stringify(product.keywords), product.monitoring ? 1 : 0, DEMO_NOW,
    );
    product.snapshots.forEach((snapshot, index) => {
      snapshotStatement.run(
        `ps-${product.id}-${index + 1}`, product.id, snapshot.date, snapshot.price, snapshot.rating,
        snapshot.reviews, snapshot.bsr, snapshot.sales, Math.round(snapshot.sales * snapshot.price * 100) / 100,
        snapshot.growth7d, snapshot.growth30d, snapshot.growth90d, DEMO_SOURCE,
        `${snapshot.date}T10:20:00+08:00`, snapshot.date, `product|US|${product.id}|${snapshot.date}|mock|${DEMO_SOURCE.trim().toLowerCase()}|30D`,
      );
    });
  }
}

function insertRelations(database: AppDatabase): void {
  const relations = [
    ['owned-sku-01', 'competitor-03', 'direct', 91, '定位、价格带与人体工学结构高度相似', ['直接竞品', '高端标杆']],
    ['owned-sku-01', 'competitor-08', 'fast_growth', 78, '新品增长快且核心词重叠', ['高增长', '新品']],
    ['owned-sku-01', 'competitor-01', 'top100', 74, '所属相邻护颈细分', ['TOP100']],
    ['owned-sku-02', 'competitor-07', 'direct', 94, '蝶翼型结构与价格直接重叠', ['直接竞品', '高 Review']],
    ['owned-sku-02', 'competitor-01', 'direct', 88, '护颈词与主功能重叠', ['直接竞品']],
    ['owned-sku-02', 'competitor-04', 'fast_growth', 79, '近 30 天排名与销量快速上升', ['高增长']],
    ['owned-sku-03', 'competitor-02', 'benchmark', 90, '轮廓枕头部销量标杆', ['高 Review', '高端标杆']],
    ['owned-sku-03', 'competitor-06', 'direct', 86, '功能相似且低价竞争', ['直接竞品', '价格杀手']],
    ['owned-sku-03', 'competitor-05', 'top100', 72, '侧睡人群与词包重叠', ['TOP100']],
    ['owned-sku-04', 'competitor-05', 'direct', 89, '侧睡人群与主价格带一致', ['直接竞品']],
    ['owned-sku-04', 'competitor-03', 'benchmark', 75, '高价人体工学产品标杆', ['高端标杆']],
    ['owned-sku-04', 'competitor-08', 'fast_growth', 70, '新品快速获量', ['高增长', '新品']],
  ] as const;
  const statement = database.prepare(`
    INSERT INTO competitor_relations (
      id, owned_product_id, competitor_product_id, relation_type, similarity_score, reason,
      ai_tags_json, created_at, last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  relations.forEach(([ownedId, competitorId, relationType, similarity, reason, tags], index) => {
    statement.run(
      `relation-${index + 1}`,
      ownedId,
      competitorId,
      relationType,
      similarity,
      reason,
      JSON.stringify(tags), DEMO_NOW, DEMO_NOW,
    );
  });
}

function insertInsights(database: AppDatabase): void {
  const statement = database.prepare(`
    INSERT INTO ai_insights (
      id, entity_type, entity_id, insight_type, status, title, summary, score, facts_json,
      opportunities_json, risks_json, recommendations_json, evidence_json, confidence, model,
      data_version, input_hash, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of demoInsights) {
    statement.run(
      item.id, item.entityType, item.entityId, item.insightType, item.status, item.title,
      item.summary, item.score ?? null, JSON.stringify(item.facts), JSON.stringify(item.opportunities),
      JSON.stringify(item.risks), JSON.stringify(item.recommendedActions), JSON.stringify(item.evidence),
      item.confidence, item.model, item.dataVersion, `seed-${item.id}`, item.generatedAt,
    );
  }
}

function insertGrowthData(database: AppDatabase): void {
  const projectRows = [
    ['dev-lumbar', '记忆棉腰靠', 'lumbar_pillow', ['lumbar pillow', 'back support pillow'], '复用海绵发泡与布套供应链', 'mkt-lumbar', 1_365_408, 18.4, 54, 'watch', 'insight-dev-lumbar'],
    ['dev-travel', 'U 型记忆棉旅行枕', 'travel_pillow', ['travel pillow', 'u shaped pillow'], '海绵工艺可复用，需新包装', 'mkt-travel', 1_253_460, 6.8, 64, 'watch', 'insight-dev-travel'],
    ['dev-seat', '人体工学坐垫', 'seat_cushion', ['seat cushion', 'office chair cushion'], '原料可复用，模具需新开', 'mkt-seat-cushion', 2_516_137, 2.6, 78, 'watch', 'insight-dev-seat'],
  ] as const;
  const projectStatement = database.prepare(`
    INSERT INTO development_projects (
      id, name, product_type, keywords_json, notes, marketplace, supply_chain_relation,
      market_node_id, market_size, growth_30d, competition_score, opportunity_score,
      status, score_breakdown_json, insight_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of projectRows) {
    const [id, name, productType, keywords, supplyRelation, marketNodeId, marketSize, growth, competition, status, insightId] = row;
    const breakdown = scoreBreakdowns[id];
    projectStatement.run(
      id, name, productType, JSON.stringify(keywords), supplyRelation, marketNodeId, marketSize,
      growth, competition, calculateOpportunityScore(breakdown), status, JSON.stringify(breakdown),
      insightId, '2026-08-28T09:00:00+08:00', DEMO_NOW,
    );
  }
  const opportunityRows = [
    ['opp-school-kit', '一年级开学实用组合包', 'AI research', '小学开学用品', 76, 14.8, 61, '$24–39', '进入深度研究', 'pending_review', '高频必需品组合可降低家长决策成本。'],
    ['opp-travel-desk', '便携式儿童书写整理套装', 'AI research', '学习整理用品', 69, 9.6, 58, '$19–29', '观察核心词季节性', 'researching', '单品需求分散，组合方案有差异化空间。'],
    ['opp-cooling-lumbar', '夏季冷感记忆棉腰靠', 'adjacent discovery', '记忆棉腰靠', 82, 21.3, 52, '$34–49', '创建 V2 Research Job', 'pending_review', '强供应链关联，冷感布套形成季节差异化。'],
  ] as const;
  const opportunityStatement = database.prepare(`
    INSERT INTO opportunities (
      id, name, source_type, market_node_id, market_name, opportunity_score, market_growth,
      competition_score, price_room, recommended_action, status, summary, evidence_json,
      created_at, updated_at, marketplace
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'US')
  `);
  for (const [id, name, sourceType, market, score, growth, competition, price, action, status, summary] of opportunityRows) {
    const evidence = [demoEvidence(`ev-${id}`, `${name} 机会分 ${score}`, [
      { name: 'opportunity_score', label: '机会评分', value: score },
      { name: 'market_growth', label: '市场增长', value: growth, unit: '%' },
      { name: 'competition_score', label: '竞争强度', value: competition },
    ])];
    opportunityStatement.run(
      id, name, sourceType, market, score, growth, competition, price, action, status,
      summary, JSON.stringify(evidence), '2026-09-05T11:00:00+08:00', DEMO_NOW,
    );
  }

  const researchNodes = [
    { id: 'research-school', name: '小学开学用品', parentId: null, level: 1, marketplace: 'US', keywords: ['school supplies'], status: '已研究', monthlySales: 186_000, monthlyRevenue: 5_620_000, growth30d: 12.4, productCount: 2_430, avgPrice: 30.2, competitionScore: 72, opportunityScore: 68, taskStatus: 'success' },
    { id: 'research-first-grade', name: '一年级开学用品', parentId: 'research-school', level: 2, marketplace: 'US', keywords: ['first grade school supplies'], status: '已研究', monthlySales: 58_400, monthlyRevenue: 1_580_000, growth30d: 14.8, productCount: 612, avgPrice: 27.1, competitionScore: 61, opportunityScore: 76, taskStatus: 'success' },
    { id: 'research-combo', name: '开学组合包', parentId: 'research-first-grade', level: 3, marketplace: 'US', keywords: ['school supply kit'], status: '已研究', monthlySales: 17_900, monthlyRevenue: 531_000, growth30d: 18.2, productCount: 138, avgPrice: 29.7, competitionScore: 54, opportunityScore: 81, taskStatus: 'success' },
  ];
  const combinations = [
    { name: '基础必需组合', items: ['铅笔', '橡皮', '削笔器', '安全剪刀', '胶棒'], rationale: '清单普适性高，便于家长一次购齐。', fit: 'recommended' },
    { name: '整理扩展组合', items: ['文件袋', '标签贴', '笔盒'], rationale: '低客单配件可增加感知价值。', fit: 'watch' },
  ];
  database.prepare(`
    INSERT INTO research_results (
      id, query, summary, nodes_json, combinations_json, opportunity_ids_json, tasks_created, generated_at
    ) VALUES ('research-demo-school', '小学一年级开学用品组合',
      '一年级必需品组合具备研究价值，建议用标准清单降低选购复杂度。',
      ?, ?, '["opp-school-kit","opp-travel-desk"]', 3, ?)
  `).run(JSON.stringify(researchNodes), JSON.stringify(combinations), DEMO_NOW);

  const watchRows = [
    ['watch-market', 'market', 'mkt-memory-foam', 'Memory Foam Pillow 市场', 'daily', DEMO_NOW, '2026-09-10T10:20:00+08:00', '30D 市场增长 8.2%', 0],
    ['watch-sku03', 'owned_product', 'owned-sku-03', 'SKU-03 舒压波浪枕', 'daily', DEMO_NOW, '2026-09-10T10:20:00+08:00', '相对市场差 -8.8%', 1],
    ['watch-comp04', 'competitor', 'competitor-04', 'DreamArc 快速增长竞品', 'weekly', '2026-09-07T10:20:00+08:00', '2026-09-14T10:20:00+08:00', '30D 销量 +31.5%', 1],
    ['watch-lumbar', 'development_project', 'dev-lumbar', '记忆棉腰靠项目', 'weekly', '2026-09-07T10:20:00+08:00', '2026-09-14T10:20:00+08:00', '机会分保持 84', 0],
  ] as const;
  const watchStatement = database.prepare(`
    INSERT INTO watchlist_items (
      id, item_type, item_id, name, marketplace, frequency, status, last_run_at, next_run_at,
      latest_finding, anomaly, created_at
    ) VALUES (?, ?, ?, ?, 'US', ?, 'active', ?, ?, ?, ?, ?)
  `);
  watchRows.forEach((row) => watchStatement.run(...row, '2026-08-30T10:00:00+08:00'));

  const taskStatement = database.prepare(`
    INSERT INTO data_tasks (
      id, name, source_id, task_type, target, source, status, started_at, completed_at,
      total, success, failed, error_log, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  taskStatement.run('task-demo-1', '记忆棉市场日常刷新', 'source-mock', 'market_refresh', 'mkt-memory-foam', DEMO_SOURCE, 'success', '2026-09-09T10:18:00+08:00', DEMO_NOW, 1_128, 1_128, 0, null, '2026-09-09T10:18:00+08:00');
  taskStatement.run('task-demo-2', '自有 SKU 快照刷新', 'source-mock', 'product_refresh', 'owned-products', DEMO_SOURCE, 'success', '2026-09-09T10:19:00+08:00', DEMO_NOW, 4, 4, 0, null, '2026-09-09T10:19:00+08:00');
  taskStatement.run('task-demo-3', '竞品增长检查', 'source-mock', 'competitor_refresh', 'watched-competitors', DEMO_SOURCE, 'partial', '2026-09-08T10:00:00+08:00', '2026-09-08T10:04:00+08:00', 8, 7, 1, '演示错误：1 个 ASIN 暂无有效快照', '2026-09-08T10:00:00+08:00');
}

export const DEMO_METADATA = {
  generatedAt: DEMO_NOW,
  source: DEMO_SOURCE,
  statusForScore: opportunityStatus,
};
