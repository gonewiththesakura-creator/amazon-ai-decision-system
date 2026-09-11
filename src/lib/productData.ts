interface ProductDataSignals {
  latest: { id: string; growth30dAvailable?: boolean; growth30d?: number | null };
  insight: { status: string };
  marketGrowth30d?: number | null;
  marketGrowth30dAvailable: boolean;
  relativeDelta?: number | null;
  relativePerformanceAvailable?: boolean;
}

interface SnapshotIdentity {
  id: string;
}

interface MarketDataSignals {
  trends: readonly { date: string }[];
  node: { growth30dAvailable: boolean; growth30d?: number | null };
}

export function compareNullableMetric(
  left: number | null | undefined,
  right: number | null | undefined,
  descending: boolean,
): number {
  const leftAvailable = typeof left === 'number' && Number.isFinite(left);
  const rightAvailable = typeof right === 'number' && Number.isFinite(right);
  if (!leftAvailable && !rightAvailable) return 0;
  if (!leftAvailable) return 1;
  if (!rightAvailable) return -1;
  return (left - right) * (descending ? -1 : 1);
}

export function hasTrustedRelativePerformance<T extends ProductDataSignals>(
  product: T,
  snapshots?: readonly SnapshotIdentity[],
): product is T & {
  latest: T['latest'] & { growth30d: number };
  marketGrowth30d: number;
  relativeDelta: number;
} {
  const hasLatestSnapshot = product.latest.id.trim().length > 0;
  const hasSnapshotHistory = snapshots === undefined || snapshots.some((snapshot) => snapshot.id.trim().length > 0);
  return hasLatestSnapshot
    && hasSnapshotHistory
    && product.latest.growth30dAvailable !== false
    && product.latest.growth30d !== null
    && product.latest.growth30d !== undefined
    && product.marketGrowth30dAvailable
    && product.marketGrowth30d !== null
    && product.relativeDelta !== null
    && product.relativeDelta !== undefined
    && product.relativePerformanceAvailable !== false
    && product.insight.status !== '数据不足';
}

export function hasTrustedMarketData(market: MarketDataSignals): boolean {
  return market.trends.some((snapshot) => snapshot.date.trim().length > 0);
}

export function hasMarketGrowthBaseline<T extends MarketDataSignals>(
  market: T,
): market is T & { node: T['node'] & { growth30d: number } } {
  return hasTrustedMarketData(market)
    && market.node.growth30dAvailable
    && market.node.growth30d !== null
    && market.node.growth30d !== undefined;
}
