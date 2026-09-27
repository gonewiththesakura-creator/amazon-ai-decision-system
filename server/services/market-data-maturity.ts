import type { MarketDataMaturity } from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { validMarketHistorySpan } from './real-history-coverage.js';

export function marketDataMaturity(database: AppDatabase, marketplace: string, marketId: string | null): MarketDataMaturity {
  const span = validMarketHistorySpan(database, marketplace, marketId, Date.now());
  const status = span.days >= 90 ? 'READY' : 'LIMITED';
  return {
    status, historyDays: span.days, observationDates: span.observationDates, hardBlocker: false,
    message: status === 'LIMITED'
      ? `LIMITED：市场历史不足90天（跨度${span.days}天，${span.observationDates}个有效观察日）。不阻止Live；禁止90天增长率、趋势及90天市场销量/销售额结论。缺失指标保持未知。`
      : `READY：真实市场历史跨度${span.days}天，${span.observationDates}个有效观察日。每项结论仍需对应指标、可比基线与Evidence，不代表日频连续或所有指标齐全。`,
  };
}

export function entityMarketMaturity(database: AppDatabase, entityType: string, entityId: string): MarketDataMaturity | undefined {
  let type = entityType, id = entityId;
  if (type === 'research_job') {
    const job = database.prepare('SELECT entity_type,entity_id,is_demo FROM research_jobs WHERE id=?').get(id);
    if (!job || job.is_demo === 1) return undefined;
    type = String(job.entity_type); id = String(job.entity_id);
  }
  const row = type === 'market'
    ? database.prepare('SELECT id,marketplace,source_type FROM market_nodes WHERE id=?').get(id)
    : type === 'product' || type === 'owned_product' || type === 'competitor'
      ? database.prepare(`SELECT m.id,m.marketplace,m.source_type FROM products p
        JOIN market_nodes m ON m.id=p.market_node_id WHERE p.id=? AND p.source_type<>'mock'`).get(id)
      : undefined;
  if (!row || row.source_type === 'mock') return undefined;
  return marketDataMaturity(database, String(row.marketplace), String(row.id));
}

export function requires90DaySupport(value: unknown): boolean {
  const pattern = /(?:90\s*(?:d(?:ay)?s?|天|日)|growth_90|sales_90|revenue_90)/i;
  if (typeof value === 'string') return pattern.test(value);
  if (Array.isArray(value)) return value.some(requires90DaySupport);
  if (value && typeof value === 'object') return Object.entries(value).some(([key,item]) =>
    // Opaque lineage identifiers are not requests for a 90-day analysis window.
    key !== 'certificationRunId' && item !== null && item !== undefined && item !== false
      && (pattern.test(key) || requires90DaySupport(item)));
  return false;
}
